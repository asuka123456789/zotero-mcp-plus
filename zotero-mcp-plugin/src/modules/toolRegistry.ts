import { PlusError, canonicalJSON, type JsonObject } from "./plusTypes.ts";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonObject;
  annotations?: JsonObject;
}

export const LEGACY_WRITE_TOOLS = new Set([
  "write_note",
  "write_tag",
  "write_metadata",
  "write_item",
  "add_by_identifier",
  "create_collection",
  "update_collection",
  "delete_collection",
  "add_items_to_collection",
  "remove_items_from_collection",
]);

const confirmation = {
  dryRun: {
    type: "boolean",
    default: true,
    description: "默认只预览；执行前必须向用户展示预览并得到确认",
  },
  confirmationToken: { type: "string", maxLength: 256 },
  idempotencyKey: { type: "string", minLength: 1, maxLength: 128 },
};
const libraryID = { type: "integer", minimum: 1 };
const key = { type: "string", pattern: "^[A-Z0-9]{8}$" };
const keys = { type: "array", items: key, minItems: 1, maxItems: 500 };
const pagination = {
  limit: { type: "integer", minimum: 1, maximum: 100 },
  offset: { type: "integer", minimum: 0 },
};
const scanScope = {
  libraryID,
  collectionKey: key,
  offset: pagination.offset,
  maxItems: { type: "integer", minimum: 1, maximum: 10000 },
};

export const PLUS_TOOLS: ToolDefinition[] = [
  {
    name: "find_standalone_attachments",
    description:
      "只读查找尚无父条目的 PDF；保留集合/全文条件并稳定分页，不下载文件或暴露绝对路径",
    inputSchema: {
      type: "object",
      properties: {
        libraryID,
        collectionKey: key,
        ...pagination,
        cursor: { type: "string", maxLength: 256 },
        query: { type: "string" },
        q: { type: "string" },
        fulltext: { type: "string" },
        fileStatus: {
          type: "string",
          enum: [
            "available",
            "not_local",
            "missing",
            "unavailable",
            "linked_url",
          ],
        },
        sort: {
          type: "string",
          enum: ["dateAdded", "dateModified", "title", "key"],
        },
        direction: { type: "string", enum: ["asc", "desc"] },
      },
      additionalProperties: false,
    },
  },
  {
    name: "recognize_pdfs",
    description:
      "批量调用 Zotero 原生 PDF 元数据识别。先预览、再确认，正式调用返回持久 taskID；可能联网和按偏好重命名文件",
    inputSchema: {
      type: "object",
      properties: { libraryID, attachmentKeys: keys, ...confirmation },
      required: ["attachmentKeys"],
      additionalProperties: false,
    },
  },
  {
    name: "task_status",
    description:
      "分页读取持久任务、逐项结果和待核查状态；成功、外部满足、取消分别计数",
    inputSchema: {
      type: "object",
      properties: { taskID: { type: "string" }, ...pagination },
      required: ["taskID"],
      additionalProperties: false,
    },
  },
  {
    name: "task_list",
    description: "分页查找跨重启保留的批处理任务，不返回任务中的全文或凭据",
    inputSchema: {
      type: "object",
      properties: {
        libraryID,
        tool: { type: "string" },
        state: { type: "string" },
        ...pagination,
      },
      additionalProperties: false,
    },
  },
  {
    name: "task_control",
    description:
      "pause/cancel 只停止后续投递，不能强制中止已进入 Zotero 的项；resume/retry 必须重新预览确认，不能绕过待核查状态",
    inputSchema: {
      type: "object",
      properties: {
        taskID: { type: "string" },
        action: {
          type: "string",
          enum: ["pause", "resume", "cancel", "retry"],
        },
        ...confirmation,
      },
      required: ["taskID", "action"],
      additionalProperties: false,
    },
  },
  {
    name: "find_duplicates",
    description:
      "只读生成重复候选及标识符/书目信息证据；相似标题不等于同一文献，不自动合并",
    inputSchema: {
      type: "object",
      properties: { ...scanScope },
      additionalProperties: false,
    },
  },
  {
    name: "merge_items",
    description:
      "显式选择 master 和字段来源，预览后执行原生合并。固定保留全部附件：donor 含 PDF/网页附件的分组不支持执行",
    inputSchema: {
      type: "object",
      properties: {
        libraryID,
        attachmentPolicy: { type: "string", enum: ["preserve_all"] },
        groups: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          items: {
            type: "object",
            properties: {
              masterKey: key,
              otherKeys: keys,
              fieldSources: { type: "object", additionalProperties: key },
              creatorsSourceKey: key,
            },
            required: ["masterKey", "otherKeys"],
            additionalProperties: false,
          },
        },
        ...confirmation,
      },
      required: ["groups"],
      additionalProperties: false,
    },
  },
  {
    name: "library_health",
    description:
      "有界只读检查独立 PDF、文件本地可用性、元数据缺项、重复候选和任务中断；只建议后续预览工具，不自动修复",
    inputSchema: {
      type: "object",
      properties: {
        ...scanScope,
        includeDuplicates: { type: "boolean", default: true },
      },
      additionalProperties: false,
    },
  },
];

// 仅支持本注册表实际声明的 JSON Schema 关键字；不静默忽略未来增加的约束。
const schemaKeys = new Set([
  "type",
  "properties",
  "additionalProperties",
  "items",
  "required",
  "enum",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "pattern",
  "description",
  "default",
  "title",
  "examples",
]);
function checkSchema(schema: JsonObject): void {
  for (const name of Object.keys(schema)) {
    if (!schemaKeys.has(name))
      throw new Error(`不支持的工具 schema 关键字: ${name}`);
  }
  for (const child of Object.values(schema.properties || {}))
    checkSchema(child as JsonObject);
  if (schema.items) checkSchema(schema.items);
  if (
    schema.additionalProperties &&
    typeof schema.additionalProperties === "object"
  )
    checkSchema(schema.additionalProperties);
}

export function validateArguments(
  schema: JsonObject,
  value: unknown,
  path = "arguments",
  depth = 0,
): void {
  const reject = (message: string): never => {
    throw new PlusError("INVALID_ARGUMENT", `${path}: ${message}`);
  };
  if (depth > 32) reject("嵌套过深");
  if (
    schema.type === "object" &&
    (value === null || typeof value !== "object" || Array.isArray(value))
  )
    reject("必须是对象");
  if (schema.type === "array" && !Array.isArray(value)) reject("必须是数组");
  if (schema.type === "string" && typeof value !== "string")
    reject("必须是字符串");
  if (schema.type === "boolean" && typeof value !== "boolean")
    reject("必须是布尔值");
  if (
    ["number", "integer"].includes(schema.type) &&
    (typeof value !== "number" || !Number.isFinite(value))
  )
    reject("必须是有限数值");
  if (schema.type === "integer" && !Number.isInteger(value))
    reject("必须是整数");
  if (
    schema.enum &&
    !schema.enum.some(
      (item: any) => canonicalJSON(item) === canonicalJSON(value),
    )
  )
    reject("值不在允许范围内");
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum)
      reject("小于允许下限");
    if (schema.maximum !== undefined && value > schema.maximum)
      reject("大于允许上限");
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength)
      reject("字符串过短");
    if (schema.maxLength !== undefined && value.length > schema.maxLength)
      reject("字符串过长");
    if (schema.pattern && !new RegExp(schema.pattern).test(value))
      reject("格式不符");
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems)
      reject("项目不足");
    if (schema.maxItems !== undefined && value.length > schema.maxItems)
      reject("项目超限");
    if (schema.items)
      value.forEach((item, index) =>
        validateArguments(schema.items, item, `${path}[${index}]`, depth + 1),
      );
  } else if (value !== null && typeof value === "object") {
    const object = value as JsonObject;
    for (const required of schema.required || []) {
      if (!Object.hasOwn(object, required)) reject(`缺少 ${required}`);
    }
    for (const [name, child] of Object.entries(object)) {
      if (["__proto__", "prototype", "constructor"].includes(name))
        reject("不允许的属性名");
      if (schema.properties?.[name])
        validateArguments(
          schema.properties[name],
          child,
          `${path}.${name}`,
          depth + 1,
        );
      else if (schema.additionalProperties === false)
        reject(`未知参数 ${name}`);
      else if (
        schema.additionalProperties &&
        typeof schema.additionalProperties === "object"
      )
        validateArguments(
          schema.additionalProperties,
          child,
          `${path}.${name}`,
          depth + 1,
        );
    }
  }
}

export class ToolRegistry {
  private entries = new Map<
    string,
    { definition: ToolDefinition; handler: (args: JsonObject) => Promise<any> }
  >();

  register(
    definition: ToolDefinition,
    handler: (args: JsonObject) => Promise<any>,
  ): void {
    if (this.entries.has(definition.name) || typeof handler !== "function")
      throw new Error(`工具注册无效: ${definition.name}`);
    const copy = JSON.parse(JSON.stringify(definition)) as ToolDefinition;
    if (LEGACY_WRITE_TOOLS.has(copy.name)) {
      copy.description +=
        " Plus 默认 dryRun=true；执行需用户确认令牌和幂等键，返回持久 taskID。";
      copy.inputSchema.properties = {
        ...copy.inputSchema.properties,
        ...confirmation,
      };
      copy.inputSchema.additionalProperties = false;
      if (copy.name === "add_by_identifier")
        copy.inputSchema.properties.identifier = { type: "string" };
    }
    const writes =
      LEGACY_WRITE_TOOLS.has(copy.name) ||
      ["recognize_pdfs", "merge_items", "task_control"].includes(copy.name);
    copy.annotations = {
      readOnlyHint: !writes,
      destructiveHint: writes,
      openWorldHint: [
        "recognize_pdfs",
        "add_by_identifier",
        "semantic_search",
        "get_content",
      ].includes(copy.name),
    };
    checkSchema(copy.inputSchema);
    this.entries.set(copy.name, { definition: copy, handler });
  }

  list(): ToolDefinition[] {
    return [...this.entries.values()].map(({ definition }) => definition);
  }

  async call(name: string, args: unknown): Promise<any> {
    const entry = this.entries.get(name);
    if (!entry) throw new PlusError("UNKNOWN_TOOL", "未知工具");
    validateArguments(entry.definition.inputSchema, args);
    return entry.handler(args as JsonObject);
  }
}
