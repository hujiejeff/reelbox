// 架构自检:一条命令回答"两层还在不在、适配器齐不齐、测试过不过"。
//
//   node scripts/verify-architecture.mjs
//
// 只做可重复的静态检查 + 跑测试,不启动应用。实机验证见 docs/ARCHITECTURE.md 第 4.5 节。
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const out = [];
let failed = 0;

function ok(name, pass, detail = "") {
  if (!pass) failed += 1;
  out.push({ name, pass, detail });
}

// 1) 适配器文件都在,且实现三个必需钩子
const adapters = [
  { id: "vod", file: "examples/vod.reelbox.js" },
  { id: "iplayr", file: "examples/iplayr.reelbox.js" },
];
for (const a of adapters) {
  const p = `${root}/${a.file}`;
  const has = existsSync(p);
  const src = has ? readFileSync(p, "utf8") : "";
  const hooks = ["list", "detail", "play"].filter((h) => src.includes(`async ${h}(`) || src.includes(`${h}:`));
  ok(`adapter ${a.id}`, has && hooks.length === 3, `${a.file} hooks=${hooks.join("/") || "无"}`);
}

// 2) 两层各自的文件在
const layers = [
  ["内核", "src-tauri/src/proxy.rs"],
  ["适配器运行时", "ui/plugin-sandbox.js"],
  ["适配器注册(内置)", "src-tauri/src/builtin.rs"],
];
for (const [name, rel] of layers) ok(`${name}`, existsSync(`${root}/${rel}`), rel);

// 3) 源里必须有 adapter 字段(架构的地基)
const model = readFileSync(`${root}/core/src/source/mod.rs`, "utf8");
ok("Source.adapter", /pub adapter:\s*String/.test(model));
ok("Source.probe", /pub probe:\s*Option<Probe>/.test(model));
ok("derive_adapter", /pub fn derive_adapter/.test(model));

// 4) 跑测试
function run(cmd, args) {
  const env = { ...process.env,
    RUSTUP_HOME: process.env.RUSTUP_HOME || "D:/rust/rustup",
    CARGO_HOME: process.env.CARGO_HOME || "D:/rust/cargo",
    PATH: `D:/rust/w64devkit/bin;D:/rust/cargo/bin;${process.env.PATH || ""}` };
  const r = spawnSync(cmd, args, { cwd: root, encoding: "utf8", env, shell: process.platform === "win32" });
  const text = `${r.stdout || ""}${r.stderr || ""}`;
  const m = text.match(/test result: ok\.\s*(\d+) passed/) || text.match(/ℹ pass (\d+)/);
  return { ok: r.status === 0 && !!m, n: m ? Number(m[1]) : 0, text };
}
const rust = run("cargo", ["test", "-p", "reelbox-core"]);
ok("cargo test -p reelbox-core", rust.ok, `${rust.n} passed`);
const ui = run("npm", ["run", "--silent", "test:ui"]);
ok("npm run test:ui", ui.ok, `${ui.n} passed`);

// 输出
const pad = Math.max(...out.map((o) => o.name.length));
for (const o of out) {
  console.log(`${o.pass ? "OK  " : "FAIL"}  ${o.name.padEnd(pad)}  ${o.detail}`);
}
console.log(`\n${out.filter((o) => o.pass).length}/${out.length} 通过`);
process.exit(failed ? 1 : 0);
