// ACID Guard istemci kodlayıcısı: acid_guard.abi.yaml ile birebir aynı düzen.
// Elle kodlama gerekçesi: yük küçük ve sabit; doğruluğu `thru abi reflect`
// ile geri okunarak kanıtlanıyor (scripts/reflect-sample.mjs).

export const ACID_PROGRAM = "taACIDvOaO1_qsjbfFCtDbNsvlArUKheO9JmPBXMBcZ_R5";
export const ACID_SEED = "acid2i709";

export const TAG = { begin: 0, commit: 1 };
export const KIND = { seq_eq: 1, data_hash: 2, absent: 3, balance_min: 4, balance_max: 5, ancestor: 6 };

const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
const h32 = (hex) => {
  const b = Buffer.from(hex.replace(/^0x/, ""), "hex");
  if (b.length !== 32) throw new Error("32 baytlik ozet bekleniyor");
  return b;
};

export const seqEq = (account, seq) => Buffer.concat([Buffer.from([KIND.seq_eq]), u16(account), u64(seq)]);
export const dataHash = (account, offset, length, sha256Hex) =>
  Buffer.concat([Buffer.from([KIND.data_hash]), u16(account), u32(offset), u32(length), h32(sha256Hex)]);
export const absent = (account) => Buffer.concat([Buffer.from([KIND.absent]), u16(account)]);
export const balanceMin = (account, amount) => Buffer.concat([Buffer.from([KIND.balance_min]), u16(account), u64(amount)]);
export const balanceMax = (account, amount) => Buffer.concat([Buffer.from([KIND.balance_max]), u16(account), u64(amount)]);
export const ancestor = (slot, blockHashHex) => Buffer.concat([Buffer.from([KIND.ancestor]), u64(slot), h32(blockHashHex)]);

export function encode(phase, predicates) {
  if (!(phase in TAG)) throw new Error(`bilinmeyen evre: ${phase}`);
  if (predicates.length > 255) throw new Error("en fazla 255 yuklem");
  return Buffer.concat([Buffer.from([TAG[phase], predicates.length]), ...predicates]);
}

// Multicall yükü: u16 calls_count, ardından her çağrı için
// u16 program_idx, u64 data_size, data (thru.common.primitives::InstructionData).
export function multicall(calls) {
  const parts = [u16(calls.length)];
  for (const { programIdx, data } of calls) parts.push(u16(programIdx), u64(data.length), Buffer.from(data));
  return Buffer.concat(parts);
}

// Hesap dizisi sırası: 0 ücret ödeyen, 1 kök program, sonra yazılabilir
// hesaplar (artan), sonra salt-okunur hesaplar (artan). Sıralama ham 32 bayt
// açık anahtar üzerinden yapılır.
export function accountIndices({ readwrite = [], readonly = [] }, decode) {
  const sortKeys = (list) => [...list].sort((a, b) => Buffer.compare(decode(a), decode(b)));
  const rw = sortKeys(readwrite);
  const ro = sortKeys(readonly);
  const idx = {};
  rw.forEach((a, i) => { idx[a] = 2 + i; });
  ro.forEach((a, i) => { idx[a] = 2 + rw.length + i; });
  return idx;
}
