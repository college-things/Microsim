import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
const exec = promisify(execFile);
const [directory, prefix = ""] = process.argv.slice(2);
if (process.platform !== "win32" || !directory) throw new Error("Usage on Windows: node scripts/check-ms14-lab.mjs directory [filename-prefix]");
const ps32 = `${process.env.SystemRoot}/SysWOW64/WindowsPowerShell/v1.0/powershell.exe`;
const ps64 = `${process.env.SystemRoot}/System32/WindowsPowerShell/v1.0/powershell.exe`;
const query = async () => {
  const r = await exec(ps64, ["-NoProfile", "-Command", "Get-Process -Name Multisim -ErrorAction SilentlyContinue | Select-Object Id,MainWindowTitle | ConvertTo-Json -Compress"], { windowsHide: true }).catch((e) => ({ stdout: e.stdout ?? "" }));
  return r.stdout.trim() ? [JSON.parse(r.stdout)].flat() : [];
};
const reports = [];
for (const name of await readdir(directory)) {
  if (!name.startsWith(prefix) || !name.endsWith(".ms14")) continue;
  const before = await query();
  let opened = false, details = "";
  try {
    const r = await exec(ps32, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", resolve("scripts/native-ms14-check.ps1"), "-Paths", resolve(directory, name)], { windowsHide: true, timeout: 25000, maxBuffer: 1000000 });
    details = r.stdout; opened = details.includes('"opened":true');
  } catch (e) { details = `${e.stdout ?? ""}\n${e.stderr ?? ""}\n${e.message}`; }
  await writeFile(join(directory, `${name}.log`), details);
  const report = { name, opened }; reports.push(report); console.log(JSON.stringify(report));
  const known = new Set(before.map((p) => p.Id));
  // A rejected malformed file can crash the COM client before Disconnect runs.
  // Clean up only a newly created hidden automation instance, never a pre-existing app.
  for (const p of await query()) if (!known.has(p.Id) && p.MainWindowTitle === "multisim") await exec(ps64, ["-NoProfile", "-Command", `Stop-Process -Id ${Number(p.Id)} -ErrorAction SilentlyContinue`], { windowsHide: true }).catch(() => {});
}
await writeFile(join(directory, `${prefix || "all"}native-check.json`), JSON.stringify(reports, null, 2));
