/**
 * Checks the catalogue widgets in `widgets/<id>/` and packages them for the signed catalogue.
 *
 * `node scripts/widgets.mjs` checks every widget folder. `packageWidgets` writes one ZIP per widget and returns its
 * catalogue entries. Packages are byte-for-byte reproducible, so a package's hash changes only when its files do. The
 * app validates every manifest again before installing.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";

/** Permissions a manifest may request, as in `WidgetPermission` in `widgets.rs`. */
const PERMISSIONS = new Set(["accounts.read.basic", "widgetData.read", "widgetData.write", "roblox.status", "roblox.join", "network.fetch", "process.spawn"]);
/** The app's limit on a package's size, as in `MAX_ARCHIVE_BYTES` in `widgets.rs`. */
const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024;
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

/** Lists a folder's files as sorted `/`-separated paths. Hidden files and folders are skipped. */
const listFiles = (root, folder = root) => readdirSync(folder, { withFileTypes: true })
  .filter((entry) => !entry.name.startsWith("."))
  .flatMap((entry) => {
    const path = join(folder, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`${relative(root, path)} is a symbolic link.`);
    return entry.isDirectory() ? listFiles(root, path) : [relative(root, path).split(sep).join("/")];
  })
  .sort();

/** Reads and checks a widget folder's manifest, returning it with the folder's files. */
export function readWidget(folder) {
  const id = folder.split(/[\\/]/).at(-1);
  const fail = (message) => { throw new Error(`Widget ${id}: ${message}`); };
  if (!existsSync(join(folder, "widget.json"))) fail("widget.json is missing.");
  let manifest;
  try { manifest = JSON.parse(readFileSync(join(folder, "widget.json"), "utf8")); } catch { fail("widget.json isn't valid JSON."); }
  const files = listFiles(folder);
  if (manifest.schemaVersion !== 1) fail("schemaVersion must be 1.");
  if (manifest.id !== id) fail(`the manifest ID must match its folder name.`);
  if (!/^[a-z0-9_]{1,64}$/.test(id)) fail("IDs may contain only lowercase letters, numbers, and underscores.");
  if (typeof manifest.name !== "string" || !manifest.name.trim()) fail("the manifest needs a name.");
  if (typeof manifest.description !== "string" || !manifest.description.trim()) fail("the manifest needs a description.");
  if (!SEMVER.test(manifest.version ?? "")) fail("the version isn't valid SemVer.");
  if (!manifest.module && !manifest.entry) fail("the manifest must declare a module or an entry page.");
  for (const key of ["module", "entry", "settingsEntry", "dashboardEntry", "icon"]) {
    if (manifest[key] && !files.includes(manifest[key])) fail(`${manifest[key]} is missing.`);
  }
  const permissions = manifest.permissions ?? [];
  for (const permission of permissions) if (!PERMISSIONS.has(permission)) fail(`${permission} isn't a known permission.`);
  if (new Set(permissions).size !== permissions.length) fail("permissions are listed more than once.");
  if (!files.includes("LICENSE")) fail("a LICENSE file is required.");
  return { manifest, files };
}

/** Builds a ZIP with fixed timestamps and sorted entries. Executable bits are kept for `optional-bin/`. */
export function buildZip(folder, files) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file);
    const data = readFileSync(join(folder, file));
    const compressed = deflateRawSync(data, { level: 9 });
    const executable = (statSync(join(folder, file)).mode & 0o111) !== 0;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0x21, 12);
    header.writeUInt32LE(crc32(data), 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE((3 << 8) | 20, 4);
    header.copy(entry, 6, 4, 30);
    entry.writeUInt32LE(((executable ? 0o100755 : 0o100644) << 16) >>> 0, 38);
    entry.writeUInt32LE(offset, 42);
    local.push(header, name, compressed);
    central.push(entry, name);
    offset += header.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

/**
 * Packages every widget in `widgetsRoot` into `outputRoot/<id>/<version>/`, which is served at `baseUrl`, and returns
 * the catalogue entries sorted by ID.
 */
export function packageWidgets(widgetsRoot, outputRoot, baseUrl) {
  if (!existsSync(widgetsRoot)) return [];
  return readdirSync(widgetsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map(({ name }) => name)
    .sort()
    .map((id) => {
      const folder = join(widgetsRoot, id);
      const { manifest, files } = readWidget(folder);
      const archive = buildZip(folder, files);
      if (archive.length > MAX_ARCHIVE_BYTES) throw new Error(`Widget ${id}: the package is larger than 20 MB.`);
      const path = `${id}/${manifest.version}`;
      mkdirSync(join(outputRoot, path), { recursive: true });
      writeFileSync(join(outputRoot, path, "package.zip"), archive);
      if (manifest.icon) copyFileSync(join(folder, manifest.icon), join(outputRoot, path, manifest.icon.split("/").at(-1)));
      return {
        id,
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        archiveUrl: `${baseUrl}${path}/package.zip`,
        sha256: createHash("sha256").update(archive).digest("hex"),
        permissions: manifest.permissions ?? [],
        ...(manifest.icon && { iconUrl: `${baseUrl}${path}/${manifest.icon.split("/").at(-1)}` }),
      };
    });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const root = "widgets";
  const ids = existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")) : [];
  for (const { name } of ids) readWidget(join(root, name));
  console.log(`Checked ${ids.length} widget${ids.length === 1 ? "" : "s"}.`);
}
