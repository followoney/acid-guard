// Her yüklem türünü içeren örnek bir yük üretir; `thru abi reflect` ile
// ABI'den geri okunarak kodlayıcının ABI ile aynı olduğu kanıtlanır.
import { writeFileSync } from "node:fs";
import { encode, seqEq, dataHash, absent, balanceMin, balanceMax, ancestor } from "./acid.mjs";

const H = "ab".repeat(32);
const sample = encode("begin", [
  seqEq(2, 41),
  dataHash(3, 0, 64, H),
  absent(4),
  balanceMin(2, 1000),
  balanceMax(2, 9000),
  ancestor(3295733, "cd".repeat(32)),
]);
writeFileSync(new URL("../acid/sample-begin.bin", import.meta.url), sample);
console.log(sample.length, sample.toString("hex"));
