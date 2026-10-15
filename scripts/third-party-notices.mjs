// Writes the license notices of every Rust crate and npm package that ships in a release build.
// Usage: node scripts/third-party-notices.mjs <output> [rust target]
import { execSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const [output = "THIRD-PARTY-NOTICES.txt", target = "x86_64-pc-windows-msvc"] = process.argv.slice(2);
const run = (command) => JSON.parse(execSync(command, { encoding: "utf8", maxBuffer: 256 << 20 }));

/** Reads LICENSE, COPYING, and NOTICE files from a package folder. */
const licenseTexts = (folder) =>
  readdirSync(folder)
    .filter((file) => /^(licen[cs]e|copying|notice)/i.test(file))
    .sort()
    .map((file) => readFileSync(join(folder, file), "utf8").trim());

const metadata = run(`cargo metadata --format-version 1 --locked --manifest-path src-tauri/Cargo.toml --filter-platform ${target}`);
const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
const shipped = new Set();
const visit = (id) => {
  if (shipped.has(id)) return;
  shipped.add(id);
  for (const dep of nodes.get(id).deps) if (dep.dep_kinds.some((kind) => kind.kind === null)) visit(dep.pkg);
};
metadata.workspace_members.forEach(visit);

const packages = [
  ...metadata.packages
    .filter((pkg) => shipped.has(pkg.id) && !metadata.workspace_members.includes(pkg.id))
    .map((pkg) => ({ name: pkg.name, version: pkg.version, license: pkg.license, folder: dirname(pkg.manifest_path) })),
  ...run("npm query .prod")
    .filter((pkg) => pkg.location)
    .map((pkg) => ({ name: pkg.name, version: pkg.version, license: pkg.license, folder: pkg.path })),
].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

const sections = packages.map((pkg) => {
  const texts = licenseTexts(pkg.folder);
  return [`${pkg.name} ${pkg.version} (${pkg.license ?? "license not declared"})`, ...(texts.length ? texts : ["No license file is included in this package."])].join("\n\n");
});
writeFileSync(output, `Toolblox includes the following third-party software.\n\n${sections.join(`\n\n${"=".repeat(80)}\n\n`)}\n`);
console.log(`Wrote notices for ${packages.length} packages to ${output}.`);
