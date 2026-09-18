import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
const manifest = JSON.parse(
  readFileSync(new URL(".scaffold/build/addon/manifest.json", root), "utf8"),
);
const application = manifest.applications?.zotero;
if (
  manifest.version !== pkg.version ||
  application?.id !== pkg.config.addonID ||
  application?.update_url !==
    "https://example.invalid/zotero-mcp-plus/updates.json"
) {
  throw new Error("产物身份、版本或更新地址与 Plus 发布约束不符，请重新构建");
}

const xpi = new URL(`.scaffold/build/${pkg.config.addonRef}.xpi`, root);
const bytes = readFileSync(xpi);
console.log(
  JSON.stringify(
    {
      version: pkg.version,
      file: fileURLToPath(xpi),
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
    null,
    2,
  ),
);
console.log("仅检查本地产物；未运行测试、提交、推送或创建 Release。");
