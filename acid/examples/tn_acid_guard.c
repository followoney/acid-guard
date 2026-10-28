#include <thru-sdk/c/tn_sdk.h>
#include <thru-sdk/c/tn_sdk_syscall.h>
#include <thru-sdk/c/tn_sdk_sha256.h>
#include "tn_acid_guard.h"

/* Byte cursor over the instruction payload. Every read is bounds-checked
   and assembled byte by byte, so packed fields never cause an unaligned
   access trap on the VM. */
typedef struct {
  uchar const * p;
  ulong         rem;
} acid_cur_t;

static inline uchar const *
acid_take( acid_cur_t * c, ulong n ) {
  if( c->rem < n ) tsdk_revert( TN_ACID_ERR_TRUNCATED );
  uchar const * at = c->p;
  c->p   += n;
  c->rem -= n;
  return at;
}

static inline uchar
acid_u8( acid_cur_t * c ) {
  return *acid_take( c, 1UL );
}

static inline ulong
acid_le( acid_cur_t * c, ulong n ) {
  uchar const * b = acid_take( c, n );
  ulong v = 0UL;
  for( ulong i = 0UL; i < n; i++ ) v |= (ulong)b[i] << ( 8UL * i );
  return v;
}

static inline int
acid_eq32( uchar const * a, uchar const * b ) {
  uchar diff = 0;
  for( ulong i = 0UL; i < 32UL; i++ ) diff |= (uchar)( a[i] ^ b[i] );
  return diff == 0;
}

static ushort
acid_account( acid_cur_t * c ) {
  ushort idx = (ushort)acid_le( c, 2UL );
  if( !tsdk_is_account_idx_valid( idx ) ) tsdk_revert( TN_ACID_ERR_BAD_ACCOUNT_IDX );
  return idx;
}

/* Isolation: the account was not modified since the client read it. */
static int
acid_seq_eq( acid_cur_t * c ) {
  ushort idx = acid_account( c );
  ulong  seq = acid_le( c, 8UL );
  if( !tsdk_account_exists( idx ) ) return 0;
  return tsdk_get_account_meta( idx )->seq == seq;
}

/* Isolation and consistency: a byte range of the account equals the
   snapshot the client hashed. Finer than seq: unrelated writes to other
   parts of the account do not abort the transaction. */
static int
acid_data_hash( acid_cur_t * c ) {
  ushort        idx  = acid_account( c );
  ulong         off  = acid_le( c, 4UL );
  ulong         len  = acid_le( c, 4UL );
  uchar const * want = acid_take( c, 32UL );
  if( !tsdk_account_exists( idx ) ) return 0;
  ulong data_sz = tsdk_get_account_meta( idx )->data_sz;
  if( off > data_sz || len > data_sz - off ) return 0;
  uchar got[32];
  uchar const * data = (uchar const *)tsdk_get_account_data_ptr( idx );
  tsdk_sha256_hash( data + off, len, got );
  return acid_eq32( got, want );
}

/* Isolation against phantoms: the address is still not a live account. */
static int
acid_absent( acid_cur_t * c ) {
  ushort idx = acid_account( c );
  return !tsdk_account_exists( idx );
}

/* Consistency: native balance invariants checked after the effects ran. */
static int
acid_balance( acid_cur_t * c, int is_min ) {
  ushort idx    = acid_account( c );
  ulong  amount = acid_le( c, 8UL );
  ulong  bal    = tsdk_account_exists( idx ) ? tsdk_get_account_meta( idx )->balance : 0UL;
  return is_min ? ( bal >= amount ) : ( bal <= amount );
}

/* Durability: the block the client built on is still in this fork's
   history. If a reorg drops it, every transaction bound to it reverts
   instead of executing against a history its author never saw. */
static int
acid_ancestor( acid_cur_t * c ) {
  ulong         slot = acid_le( c, 8UL );
  uchar const * want = acid_take( c, 32UL );
  ulong         now  = tsdk_get_current_block_ctx()->slot;
  if( slot >= now ) return 0;
  for( ulong back = 1UL; back < TN_ACID_BLOCK_SPAN && back <= now; back++ ) {
    tsdk_block_ctx_t const * ctx = tsdk_get_past_block_ctx( back );
    if( ctx->slot == slot ) return acid_eq32( ctx->cur_block_hash.hash, want );
    if( ctx->slot <  slot ) return 0;
  }
  return 0;
}

static void
acid_check( uchar const * instr, ulong instr_sz ) {
  acid_cur_t c = { instr, instr_sz };

  uchar tag = acid_u8( &c );
  if( tag != TN_ACID_TAG_BEGIN && tag != TN_ACID_TAG_COMMIT ) tsdk_revert( TN_ACID_ERR_BAD_TAG );

  uchar count = acid_u8( &c );
  for( uchar i = 0; i < count; i++ ) {
    uchar kind = acid_u8( &c );
    int   ok;
    switch( kind ) {
      case TN_ACID_PRED_SEQ_EQ:      ok = acid_seq_eq( &c );     break;
      case TN_ACID_PRED_DATA_HASH:   ok = acid_data_hash( &c );  break;
      case TN_ACID_PRED_ABSENT:      ok = acid_absent( &c );     break;
      case TN_ACID_PRED_BALANCE_MIN: ok = acid_balance( &c, 1 ); break;
      case TN_ACID_PRED_BALANCE_MAX: ok = acid_balance( &c, 0 ); break;
      case TN_ACID_PRED_ANCESTOR:    ok = acid_ancestor( &c );   break;
      default: tsdk_revert( TN_ACID_ERR_BAD_KIND );
    }
    if( !ok ) tsdk_revert( TN_ACID_ERR_FAIL( kind, i ) );
  }
  if( c.rem != 0UL ) tsdk_revert( TN_ACID_ERR_TRAILING_BYTES );

  tn_acid_event_t ev = {
    .phase   = tag,
    .checked = count,
    .slot    = tsdk_get_current_block_ctx()->slot,
  };
  if( tsys_emit_event( (uchar const *)&ev, sizeof( ev ) ) != TSDK_SUCCESS ) {
    tsdk_revert( TN_ACID_ERR_EVENT_FAILED );
  }
}

/* The runtime jumps to address 0 with a0/a1 set to the instruction for
   cross-program calls (e.g. from Multicall). At the root frame the
   payload is the transaction's own instruction data. */
TSDK_ENTRYPOINT_FN void
start( uchar const * cpi_instr, ulong cpi_instr_sz ) {
  uchar const * instr;
  ulong         instr_sz;
  if( tsdk_get_shadow_stack()->call_depth <= 1U ) {
    tsdk_txn_t const * txn = tsdk_get_txn();
    instr    = tsdk_txn_get_instr_data( txn );
    instr_sz = tsdk_txn_get_instr_data_sz( txn );
  } else {
    instr    = cpi_instr;
    instr_sz = cpi_instr_sz;
  }
  acid_check( instr, instr_sz );
  tsdk_return( TSDK_SUCCESS );
}
