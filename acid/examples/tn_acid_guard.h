#ifndef TN_ACID_GUARD_H
#define TN_ACID_GUARD_H

/* ACID Guard: a stateless transaction guard for Thru.

   Thru already gives every transaction Atomicity (any revert rolls back
   every account change). This program adds the other three letters as
   predicates a client places around arbitrary program calls inside one
   Multicall transaction:

     begin  : read-set validation  -> Isolation   (seq_eq, data_hash, absent)
     commit : postconditions       -> Consistency (balance_min/max, data_hash)
     either : fork binding         -> Durability  (ancestor)

   If any predicate fails, the guard reverts and the whole transaction,
   including every call placed before it, is rolled back.

   Wire format (little-endian, packed):

     u8  tag            0 = begin, 1 = commit (same checker, phase is logged)
     u8  count          number of predicates that follow
     count x {
       u8 kind
       body (by kind)
     }

   The guard owns no accounts and keeps no storage. */

#include <thru-sdk/c/tn_sdk.h>

#define TN_ACID_TAG_BEGIN  (0U)
#define TN_ACID_TAG_COMMIT (1U)

/* Predicate kinds */
#define TN_ACID_PRED_SEQ_EQ      (1U) /* u16 account_index, u64 seq                              */
#define TN_ACID_PRED_DATA_HASH   (2U) /* u16 account_index, u32 offset, u32 length, u8[32] sha256 */
#define TN_ACID_PRED_ABSENT      (3U) /* u16 account_index                                       */
#define TN_ACID_PRED_BALANCE_MIN (4U) /* u16 account_index, u64 amount                           */
#define TN_ACID_PRED_BALANCE_MAX (5U) /* u16 account_index, u64 amount                           */
#define TN_ACID_PRED_ANCESTOR    (6U) /* u64 slot, u8[32] block_hash                             */

/* User error codes read as "AC1D" in hex.
   Predicate failure: 0xAC1D_KK_II (KK = predicate kind, II = predicate index).
   Malformed input:   0xAC1D_FF_RR (RR = reason). */
#define TN_ACID_ERR_BASE            (0xAC1D0000UL)
#define TN_ACID_ERR_FAIL(kind, idx) (TN_ACID_ERR_BASE | ((ulong)(kind) << 8) | (ulong)(idx))

#define TN_ACID_ERR_TRUNCATED       (0xAC1DFF01UL)
#define TN_ACID_ERR_BAD_TAG         (0xAC1DFF02UL)
#define TN_ACID_ERR_BAD_KIND        (0xAC1DFF03UL)
#define TN_ACID_ERR_BAD_ACCOUNT_IDX (0xAC1DFF04UL)
#define TN_ACID_ERR_TRAILING_BYTES  (0xAC1DFF05UL)
#define TN_ACID_ERR_EVENT_FAILED    (0xAC1DFF06UL)

/* History window the runtime exposes to programs (TN_RUNTIME_CTX_BLOCK_SPAN). */
#define TN_ACID_BLOCK_SPAN (512UL)

/* Event emitted after every passing check: 1 + 1 + 8 = 10 bytes. */
typedef struct __attribute__((packed)) {
  uchar phase;   /* 0 = begin, 1 = commit */
  uchar checked; /* predicates verified   */
  ulong slot;    /* slot the check ran in */
} tn_acid_event_t;

#endif /* TN_ACID_GUARD_H */
