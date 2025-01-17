import { readFile } from "node:fs/promises";
import { parse, join } from "node:path";

export default async function resolve(filePath) {
  const meta = parse(filePath);
  const tsSrcPath = join(meta.dir, meta.name) + ".ts";
  try {
    // try to read typescript version first
    await readFile(tsSrcPath, { encoding: "utf8" });
    return tsSrcPath;
  } catch (err) {
    if (err.errno !== -2) {
      console.log(err);
    }
    // assume no ts, since reading it failed
    return filePath;
  }
}
