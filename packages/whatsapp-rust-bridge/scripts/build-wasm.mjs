#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const pkgWasm = resolve(root, "pkg/whatsapp_rust_bridge_bg.wasm");
const outDir = resolve(root, "assets/wasm");
const distWasmDir = resolve(root, "dist/wasm");
const cargoFeatures = process.env.WHATSAPP_RUST_BRIDGE_CARGO_FEATURES?.trim();

const wasmOptFlags = [
  "-O4",
  "--gufa-optimizing",
  "--inlining-optimizing",
  "--ignore-implicit-traps",
  "--traps-never-happen",
  "--coalesce-locals-learning",
  "--converge",
  "--enable-bulk-memory",
  "--enable-nontrapping-float-to-int",
  "--enable-sign-ext",
  "--enable-mutable-globals",
  "--enable-multivalue",
  "--fast-math",
  "--zero-filled-memory",
  "--dce",
  "--vacuum",
  "--directize",
  "--optimize-stack-ir",
  "--strip-debug",
];

function run(cmd, args, env = {}) {
  console.log(`\n$ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  if (r.status !== 0) {
    process.exit(r.status ?? 1);
  }
}

function build(variant) {
  const isSimd = variant === "simd";
  const rustflags = isSimd
    ? "-C target-feature=+simd128"
    : "-C target-feature=-simd128";

  console.log(`\n=== Building ${variant} ===`);
  const wasmPackArgs = [
    "build",
    "--target",
    "web",
    "--out-dir",
    "pkg",
    "--no-pack",
    "--no-opt",
  ];
  if (cargoFeatures) {
    wasmPackArgs.push("--features", cargoFeatures);
  }
  run("wasm-pack", wasmPackArgs, { RUSTFLAGS: rustflags });

  const outFile = resolve(outDir, `${variant}.wasm`);
  const optFlags = [
    ...wasmOptFlags,
    isSimd ? "--enable-simd" : "--disable-simd",
    pkgWasm,
    "-o",
    outFile,
  ];
  run("wasm-opt", optFlags);

  const size = statSync(outFile).size;
  console.log(`  → ${outFile} (${(size / 1024).toFixed(1)} KB)`);
}

function wasmBindgenTrampolines(wasmPath) {
  const module = new WebAssembly.Module(readFileSync(wasmPath));
  return WebAssembly.Module.exports(module)
    .map(({ name }) => name)
    .filter((name) => name.startsWith("__wasm_bindgen_func_elem_"));
}

function alignSimdExportsWithGlue() {
  const simdPath = resolve(outDir, "simd.wasm");
  const nosimdPath = resolve(outDir, "nosimd.wasm");
  const simdExports = wasmBindgenTrampolines(simdPath);
  const glueExports = wasmBindgenTrampolines(nosimdPath);

  if (simdExports.length !== glueExports.length) {
    throw new Error(
      `SIMD/non-SIMD wasm-bindgen trampoline count differs (${simdExports.length} !== ${glueExports.length})`
    );
  }

  const wasm = readFileSync(simdPath);
  for (let i = 0; i < simdExports.length; i++) {
    const sourceName = simdExports[i];
    const targetName = glueExports[i];
    if (sourceName === targetName) continue;
    if (sourceName.length !== targetName.length) {
      throw new Error(
        `Cannot align wasm-bindgen trampoline names with different lengths: ${sourceName} -> ${targetName}`
      );
    }

    const source = Buffer.from(sourceName);
    const offset = wasm.indexOf(source);
    if (offset < 0 || wasm.indexOf(source, offset + 1) >= 0) {
      throw new Error(`Expected exactly one export named ${sourceName}`);
    }
    Buffer.from(targetName).copy(wasm, offset);
  }

  writeFileSync(simdPath, wasm);
  const alignedExports = wasmBindgenTrampolines(simdPath);
  if (alignedExports.some((name, i) => name !== glueExports[i])) {
    throw new Error(
      "Failed to align SIMD wasm-bindgen exports with generated glue"
    );
  }
}

if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

build("simd");
build("nosimd");

// wasm-bindgen can number async trampoline exports differently when target
// features change. The JS glue comes from the final non-SIMD build, so align
// the equivalent SIMD export names before both binaries share that glue.
alignSimdExportsWithGlue();

// Keep wasm-bindgen's generated pkg/ output internally consistent. The
// published Node entry points resolve the two explicit dist/wasm assets.
copyFileSync(resolve(outDir, "simd.wasm"), pkgWasm);

mkdirSync(distWasmDir, { recursive: true });
for (const variant of ["simd", "nosimd"]) {
  copyFileSync(
    resolve(outDir, `${variant}.wasm`),
    resolve(distWasmDir, `${variant}.wasm`),
  );
}

console.log("\nDual wasm build complete.");
