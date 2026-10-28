// ACID Guard canlı gösterimi (alphanet). Her adım gerçek bir işlem gönderir.
// Kullanım: node demo.mjs [adim...]   adımlar: probe isolation consistency durability phantom
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import {
  ACID_PROGRAM, encode, seqEq, dataHash, absent, balanceMin, balanceMax, ancestor, multicall, accountIndices,
} from "./acid.mjs";

const THRU = "/home/followoney/.local/root/usr/bin/thru";
const NET = "alphanet";
const EXPLORER = "https://scan.thru.org";
const DEFAULT = "taH-uDnuae5Im0lQhtwS6Xlgl0zOM_ukGxp1RBxS4w0ni2";
const BOB = "taJDP0ah9uVPju9_U9y9GxBCkBfVNbmG_ztaaHUIyYmWWZ";
const EOA = "taEOAD2uLK1SLzPgtabFLUAx22yDlBs9DE9nZFTOESIGRr";
const MULTICALL = "taMULTIrOL8WpIFr16C1ECsO60qAsuwmwJephZHDOTvSeP";
const BIN = new URL("../acid/build/thruvm/bin/tn_acid_guard_c.bin", import.meta.url);
const RESULTS = new URL("../demo-results.json", import.meta.url);

const pubkey = (addr) => Buffer.from(addr.slice(2), "base64url").subarray(0, 32);

function thru(args) {
  const r = spawnSync("wsl.exe", ["-d", "Ubuntu-24.04", "-e", THRU, "--json", ...args], { encoding: "utf8" });
  const out = (r.stdout || "").trim();
  const start = out.indexOf("{");
  if (start < 0) throw new Error(`thru ${args[0]} cikti vermedi: ${r.stderr || out}`);
  return JSON.parse(out.slice(start));
}

function account(addr) {
  const a = thru(["getaccountinfo", addr]).account_info;
  if (!a) throw new Error(`hesap okunamadi: ${addr}`);
  return { seq: BigInt(a.seq), balance: BigInt(a.balance), raw: a };
}

function execute(program, data, { readwrite = [], readonly = [] } = {}) {
  // varsayılan bütçe 0: CU ve bellek sayfaları açıkça istenmeli
  const args = ["txn", "execute", "--fee", "0", "--compute-units", "4000000", "--memory-units", "64"];
  const sortKeys = (l) => [...l].sort((a, b) => Buffer.compare(pubkey(a), pubkey(b)));
  for (const a of sortKeys(readwrite)) args.push("--readwrite-accounts", a);
  for (const a of sortKeys(readonly)) args.push("--readonly-accounts", a);
  args.push(program, Buffer.from(data).toString("hex"));
  return thru(args);
}

const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
const eoaTransfer = (amount, from, to) => Buffer.concat([u32(1), u64(amount), u16(from), u16(to)]);

async function recentBlock(back = 8) {
  const res = await fetch(`${EXPLORER}/api/blocks/recent?network=${NET}&limit=${back + 1}`);
  const blocks = (await res.json()).data.blocks;
  const b = blocks[blocks.length - 1];
  return { slot: BigInt(b.slot), hash: b.blockHash };
}

const results = existsSync(RESULTS) ? JSON.parse(readFileSync(RESULTS, "utf8")) : {};
function record(step, label, expect, res, extra = {}) {
  // başarı: { transaction_execute }, zincirde düşen işlem: { error: { type: "transaction_failed", ... } }
  const r = res.transaction_execute ?? res.error;
  if (!r?.signature) throw new Error(`imzasiz sonuc: ${JSON.stringify(res)}`);
  const entry = {
    label, expect,
    status: res.transaction_execute ? "SUCCESS" : "FAILED",
    signature: r.signature,
    url: `${EXPLORER}/tx/${r.signature}?network=${NET}`,
    slot: r.slot,
    vm_error: r.vm_error_name ?? r.vm_error_label ?? r.vm_error,
    user_error_code: r.user_error_code_hex ?? `0x${BigInt(r.user_error_code ?? 0).toString(16).toUpperCase()}`,
    compute_units: r.compute_units_consumed,
    events: r.events_count,
    ...extra,
  };
  (results[step] ??= []).push(entry);
  writeFileSync(RESULTS, JSON.stringify(results, null, 2));
  console.log(`[${step}] ${label}\n  beklenen=${expect} sonuc=${entry.status} kod=${entry.user_error_code} vm=${entry.vm_error} cu=${entry.compute_units ?? "-"}\n  ${entry.url}`);
  return entry;
}

const MC_ACCOUNTS = { readwrite: [BOB], readonly: [ACID_PROGRAM, EOA] };
const mcIdx = () => accountIndices(MC_ACCOUNTS, pubkey);

const steps = {
  // CPI yolunu ve kök yolunu sına; ham JSON'u göster
  async probe() {
    const root = execute(ACID_PROGRAM, encode("begin", []));
    console.log(JSON.stringify(root, null, 2));
    const idx = mcIdx();
    const mc = execute(MULTICALL, multicall([{ programIdx: idx[ACID_PROGRAM], data: encode("begin", []) }]), MC_ACCOUNTS);
    console.log(JSON.stringify(mc, null, 2));
  },

  // I + A: eski okumayla yazılmış işlem reddedilir, transfer hiç gerçekleşmez
  async isolation() {
    const idx = mcIdx();
    const before = account(BOB);
    thru(["transfer", "default", BOB, "1"]); // eşzamanlı yazar: bob'un seq'i ilerler
    const mid = account(BOB);
    console.log(`bob seq ${before.seq} -> ${mid.seq}, bakiye ${before.balance} -> ${mid.balance}`);
    const stale = execute(MULTICALL, multicall([
      { programIdx: idx[ACID_PROGRAM], data: encode("begin", [seqEq(idx[BOB], before.seq)]) },
      { programIdx: idx[EOA], data: eoaTransfer(100, 0, idx[BOB]) },
    ]), MC_ACCOUNTS);
    const after = account(BOB);
    record("isolation", "stale read: begin seq_eq(bob, old) + transfer 100", "FAIL 0xAC1D0100", stale,
      { bob_balance_before: String(mid.balance), bob_balance_after: String(after.balance) });

    const fresh = execute(MULTICALL, multicall([
      { programIdx: idx[ACID_PROGRAM], data: encode("begin", [seqEq(idx[BOB], after.seq)]) },
      { programIdx: idx[EOA], data: eoaTransfer(100, 0, idx[BOB]) },
      { programIdx: idx[ACID_PROGRAM], data: encode("commit", [balanceMin(idx[BOB], after.balance + 100n)]) },
    ]), MC_ACCOUNTS);
    const done = account(BOB);
    record("isolation", "fresh read: begin seq_eq(bob, current) + transfer 100 + commit balance_min", "SUCCESS", fresh,
      { bob_balance_before: String(after.balance), bob_balance_after: String(done.balance) });
  },

  // C + A: transfer çalıştıktan SONRA değişmez bozulur, transfer geri alınır
  async consistency() {
    const idx = mcIdx();
    const before = account(BOB);
    const res = execute(MULTICALL, multicall([
      { programIdx: idx[EOA], data: eoaTransfer(100, 0, idx[BOB]) },
      { programIdx: idx[ACID_PROGRAM], data: encode("commit", [balanceMax(idx[BOB], before.balance)]) },
    ]), MC_ACCOUNTS);
    const after = account(BOB);
    record("consistency", "transfer 100 then commit balance_max(bob, old balance)", "FAIL 0xAC1D0500 and rollback", res,
      { bob_balance_before: String(before.balance), bob_balance_after: String(after.balance) });
  },

  // D: işlem, yazarının gördüğü bloğa bağlanır
  async durability() {
    const { slot, hash } = await recentBlock(8);
    const ok = execute(ACID_PROGRAM, encode("begin", [ancestor(slot, hash)]));
    record("durability", `ancestor(slot ${slot}, explorer hash)`, "SUCCESS", ok, { slot: String(slot), hash });
    const forged = hash.slice(0, -2) + (hash.endsWith("00") ? "01" : "00");
    const bad = execute(ACID_PROGRAM, encode("begin", [ancestor(slot, forged)]));
    record("durability", `ancestor(slot ${slot}, forged hash)`, "FAIL 0xAC1D0600", bad, { slot: String(slot), hash: forged });
  },

  // I (hayalet) + kod sabitleme
  async phantom() {
    const ghost = "ta" + Buffer.concat([createHash("sha256").update("acid-guard-phantom-demo").digest(), Buffer.alloc(1)]).toString("base64url");
    const addr = fixChecksum(ghost);
    const ok = execute(ACID_PROGRAM, encode("begin", [absent(2)]), { readonly: [addr] });
    record("phantom", "absent(never-created address)", "SUCCESS", ok, { address: addr });
    const bad = execute(ACID_PROGRAM, encode("begin", [absent(2)]), { readonly: [BOB] });
    record("phantom", "absent(bob, a live account)", "FAIL 0xAC1D0300", bad);

    const code = readFileSync(BIN);
    const sha = createHash("sha256").update(code).digest("hex");
    const pin = execute(ACID_PROGRAM, encode("begin", [dataHash(1, 0, code.length, sha)]));
    record("phantom", `code pin: data_hash(ACID program, 0, ${code.length}, sha256 of audited binary)`, "SUCCESS", pin, { sha256: sha });
  },
};

// thrufmt: 32 bayt anahtar + 1 bayt sağlama (bayt toplamı mod 256)
function fixChecksum(addr) {
  const key = pubkey(addr);
  const sum = key.reduce((s, x) => (s + x) & 0xff, 0);
  return "ta" + Buffer.concat([key, Buffer.from([sum])]).toString("base64url");
}

const wanted = process.argv.slice(2);
for (const name of wanted.length ? wanted : ["isolation", "consistency", "durability", "phantom"]) {
  if (!steps[name]) throw new Error(`bilinmeyen adim: ${name}`);
  await steps[name]();
}
