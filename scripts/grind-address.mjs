// Yönetilen program adresini istenen önekle başlatan tohumu arar.
// Türetme (@thru/programs/manager ile aynı):
//   meta    = SHA256(manager || ephemeral || pad32(seed))
//   program = SHA256(manager || ephemeral || meta)
// Kullanım: node grind-address.mjs ACID acid [isci_sayisi]
import { createHash } from "node:crypto";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import os from "node:os";

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const MAX_SEED = 14; // CLI geçici tohuma "_upgrade_temporary" (18) ekler: 14 + 18 = 32

function prefixBits(prefix) {
  // base64url karakterlerini bit dizisine çevir: ilk 6*n bit sabitlenir
  const bits = [];
  for (const ch of prefix) {
    const v = B64URL.indexOf(ch);
    if (v < 0) throw new Error(`base64url disi karakter: ${ch}`);
    for (let i = 5; i >= 0; i--) bits.push((v >> i) & 1);
  }
  return bits;
}

function matches(bytes, bits) {
  for (let i = 0; i < bits.length; i++) {
    if (((bytes[i >> 3] >> (7 - (i & 7))) & 1) !== bits[i]) return false;
  }
  return true;
}

function pad32(str) {
  const out = Buffer.alloc(32);
  out.write(str, "ascii");
  return out;
}

function derive(manager, seed32) {
  const zero = Buffer.from([0]);
  const meta = createHash("sha256").update(manager).update(zero).update(seed32).digest();
  const prog = createHash("sha256").update(manager).update(zero).update(meta).digest();
  return { meta, prog };
}

if (isMainThread) {
  const [prefix = "ACID", stem = "acid", workersArg] = process.argv.slice(2);
  const { MANAGER_PROGRAM_PUBKEY, deriveManagedProgramAddresses } = await import("@thru/programs/manager");
  const manager = Buffer.from(MANAGER_PROGRAM_PUBKEY);

  // Formülü kütüphaneye karşı doğrula
  const probe = deriveManagedProgramAddresses("thru_program");
  const mine = derive(manager, pad32("thru_program"));
  if (Buffer.compare(mine.prog, Buffer.from(probe.programAccountBytes)) !== 0) {
    throw new Error("turetme formulu kutuphaneyle uyusmuyor");
  }

  const n = Number(workersArg ?? Math.max(1, Math.min(2, os.cpus().length)));
  const started = Date.now();
  console.log(`onek=${prefix} kok=${stem} isci=${n} beklenen deneme ~${(64 ** prefix.length).toLocaleString()}`);
  let done = false;
  const workers = [];
  for (let w = 0; w < n; w++) {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: { prefix, stem, manager, offset: w, stride: n },
    });
    worker.on("message", async (msg) => {
      if (msg.type === "progress") return;
      if (done) return;
      done = true;
      for (const x of workers) x.terminate();
      const lib = deriveManagedProgramAddresses(msg.seed);
      console.log(JSON.stringify({
        seed: msg.seed,
        meta: lib.programMetaAccountAddress,
        program: lib.programAccountAddress,
        tries: msg.tries,
        seconds: (Date.now() - started) / 1000,
      }));
    });
    workers.push(worker);
  }
} else {
  const { prefix, stem, offset, stride } = workerData;
  const manager = Buffer.from(workerData.manager);
  const bits = prefixBits(prefix);
  let tries = 0;
  for (let i = offset; ; i += stride) {
    const seed = stem + i.toString(36);
    if (seed.length > MAX_SEED) throw new Error("tohum alani tukendi");
    const { prog } = derive(manager, pad32(seed));
    tries++;
    if (matches(prog, bits)) {
      parentPort.postMessage({ type: "found", seed, tries: tries * stride });
      break;
    }
  }
}
