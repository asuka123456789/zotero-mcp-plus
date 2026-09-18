import { expect } from "chai";
import {
  ToolRegistry,
  validateArguments,
  PLUS_TOOLS,
  LEGACY_WRITE_TOOLS,
  type ToolDefinition,
} from "../../src/modules/toolRegistry.ts";
import { PlusError } from "../../src/modules/plusTypes.ts";

describe("ToolRegistry unit tests", function () {
  describe("validateArguments strict schema validation", function () {
    describe("Strict boolean validation", function () {
      const boolSchema = { type: "boolean" };

      it("accepts valid booleans true and false", function () {
        expect(() => validateArguments(boolSchema, true)).to.not.throw();
        expect(() => validateArguments(boolSchema, false)).to.not.throw();
      });

      it("strictly rejects string booleans, numbers, null, undefined (must be boolean)", function () {
        expect(() => validateArguments(boolSchema, "true")).to.throw(
          PlusError,
          /必须是布尔值/,
        );
        expect(() => validateArguments(boolSchema, "false")).to.throw(
          PlusError,
          /必须是布尔值/,
        );
        expect(() => validateArguments(boolSchema, 1)).to.throw(
          PlusError,
          /必须是布尔值/,
        );
        expect(() => validateArguments(boolSchema, 0)).to.throw(
          PlusError,
          /必须是布尔值/,
        );
        expect(() => validateArguments(boolSchema, null)).to.throw(
          PlusError,
          /必须是布尔值/,
        );
        expect(() => validateArguments(boolSchema, undefined)).to.throw(
          PlusError,
          /必须是布尔值/,
        );
      });
    });

    describe("Rejection of extra properties (additionalProperties: false)", function () {
      const objectSchema = {
        type: "object",
        properties: {
          name: { type: "string" },
        },
        additionalProperties: false,
      };

      it("accepts object with only declared properties", function () {
        expect(() =>
          validateArguments(objectSchema, { name: "test" }),
        ).to.not.throw();
      });

      it("strictly rejects unknown extra properties", function () {
        expect(() =>
          validateArguments(objectSchema, {
            name: "test",
            extraProp: "unwanted",
          }),
        ).to.throw(PlusError, /未知参数 extraProp/);
      });

      it("strictly rejects forbidden prototype pollution properties (__proto__, constructor, prototype)", function () {
        // Test __proto__
        const badPayload = JSON.parse(
          '{"name": "test", "__proto__": {"polluted": true}}',
        );
        expect(() => validateArguments(objectSchema, badPayload)).to.throw(
          PlusError,
          /不允许的属性名|未知参数/,
        );

        expect(() =>
          validateArguments(objectSchema, { name: "test", constructor: "bad" }),
        ).to.throw(PlusError, /不允许的属性名|未知参数/);

        expect(() =>
          validateArguments(objectSchema, { name: "test", prototype: "bad" }),
        ).to.throw(PlusError, /不允许的属性名|未知参数/);
      });
    });

    describe("Integer and number strictness", function () {
      const intSchema = { type: "integer", minimum: 1, maximum: 10 };

      it("accepts integer within range", function () {
        expect(() => validateArguments(intSchema, 5)).to.not.throw();
        expect(() => validateArguments(intSchema, 1)).to.not.throw();
        expect(() => validateArguments(intSchema, 10)).to.not.throw();
      });

      it("rejects non-integers, floats, NaN, and Infinity", function () {
        expect(() => validateArguments(intSchema, 5.5)).to.throw(
          PlusError,
          /必须是整数/,
        );
        expect(() => validateArguments(intSchema, NaN)).to.throw(
          PlusError,
          /必须是有限数值/,
        );
        expect(() => validateArguments(intSchema, Infinity)).to.throw(
          PlusError,
          /必须是有限数值/,
        );
        expect(() => validateArguments(intSchema, "5")).to.throw(
          PlusError,
          /必须是有限数值/,
        );
      });

      it("rejects values outside minimum and maximum bounds", function () {
        expect(() => validateArguments(intSchema, 0)).to.throw(
          PlusError,
          /小于允许下限/,
        );
        expect(() => validateArguments(intSchema, 11)).to.throw(
          PlusError,
          /大于允许上限/,
        );
      });
    });

    describe("String length and pattern constraints", function () {
      const keySchema = {
        type: "string",
        pattern: "^[A-Z0-9]{8}$",
      };

      it("accepts valid 8-character uppercase alphanumeric Zotero key", function () {
        expect(() => validateArguments(keySchema, "ABCDEF12")).to.not.throw();
        expect(() => validateArguments(keySchema, "12345678")).to.not.throw();
      });

      it("rejects lowercase letters, symbols, or invalid length", function () {
        expect(() => validateArguments(keySchema, "abcdef12")).to.throw(
          PlusError,
          /格式不符/,
        );
        expect(() => validateArguments(keySchema, "ABCDE12")).to.throw(
          PlusError,
          /格式不符/,
        );
        expect(() => validateArguments(keySchema, "ABCDEF123")).to.throw(
          PlusError,
          /格式不符/,
        );
        expect(() => validateArguments(keySchema, "ABC-EF12")).to.throw(
          PlusError,
          /格式不符/,
        );
      });
    });

    describe("Array items and minItems / maxItems constraints", function () {
      const arraySchema = {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        maxItems: 3,
      };

      it("accepts valid array within count bounds", function () {
        expect(() => validateArguments(arraySchema, ["a", "b"])).to.not.throw();
      });

      it("rejects non-array or array outside bounds", function () {
        expect(() => validateArguments(arraySchema, "not-array")).to.throw(
          PlusError,
          /必须是数组/,
        );
        expect(() => validateArguments(arraySchema, [])).to.throw(
          PlusError,
          /项目不足/,
        );
        expect(() =>
          validateArguments(arraySchema, ["a", "b", "c", "d"]),
        ).to.throw(PlusError, /项目超限/);
      });

      it("recursively validates array item types", function () {
        expect(() =>
          validateArguments(arraySchema, ["a", 123 as any]),
        ).to.throw(PlusError, /arguments\[1\]: 必须是字符串/);
      });
    });

    describe("Required properties and nesting depth", function () {
      const reqSchema = {
        type: "object",
        properties: {
          id: { type: "string" },
        },
        required: ["id"],
      };

      it("rejects when required property is missing", function () {
        expect(() => validateArguments(reqSchema, {})).to.throw(
          PlusError,
          /缺少 id/,
        );
      });

      it("rejects deeply nested structures (> 32 levels)", function () {
        let nested: any = "leaf";
        for (let i = 0; i < 35; i++) {
          nested = [nested];
        }
        const deepSchema: any = {
          type: "array",
          items: {
            type: "array",
            items: {
              type: "array",
            },
          },
        };
        // Construct recursive items schema
        let currentSchema: any = { type: "string" };
        for (let i = 0; i < 35; i++) {
          currentSchema = { type: "array", items: currentSchema };
        }
        expect(() => validateArguments(currentSchema, nested)).to.throw(
          PlusError,
          /嵌套过深/,
        );
      });
    });
  });

  describe("ToolRegistry functionality", function () {
    let registry: ToolRegistry;

    beforeEach(function () {
      registry = new ToolRegistry();
    });

    it("registers and calls tool successfully", async function () {
      const toolDef: ToolDefinition = {
        name: "test_echo",
        description: "Echoes input back",
        inputSchema: {
          type: "object",
          properties: {
            msg: { type: "string" },
          },
          required: ["msg"],
          additionalProperties: false,
        },
      };

      registry.register(toolDef, async (args) => {
        return { echoed: args.msg };
      });

      const result = await registry.call("test_echo", { msg: "hello" });
      expect(result).to.deep.equal({ echoed: "hello" });
    });

    it("rejects duplicate tool registration", function () {
      const toolDef: ToolDefinition = {
        name: "duplicate_tool",
        description: "Test duplicate",
        inputSchema: { type: "object", additionalProperties: false },
      };

      registry.register(toolDef, async () => ({}));
      expect(() => registry.register(toolDef, async () => ({}))).to.throw(
        /工具注册无效/,
      );
    });

    it("rejects unknown tool call (UNKNOWN_TOOL)", async function () {
      let caught: any = null;
      try {
        await registry.call("non_existent_tool", {});
      } catch (err) {
        caught = err;
      }
      expect(caught).to.be.instanceOf(PlusError);
      expect(caught.code).to.equal("UNKNOWN_TOOL");
    });

    it("validates input arguments against schema before invoking handler", async function () {
      let handlerCalled = false;
      const toolDef: ToolDefinition = {
        name: "strict_input_tool",
        description: "Requires integer count",
        inputSchema: {
          type: "object",
          properties: {
            count: { type: "integer", minimum: 1 },
          },
          required: ["count"],
          additionalProperties: false,
        },
      };

      registry.register(toolDef, async () => {
        handlerCalled = true;
        return { ok: true };
      });

      let caught: any = null;
      try {
        await registry.call("strict_input_tool", { count: "invalid" });
      } catch (err) {
        caught = err;
      }
      expect(caught).to.be.instanceOf(PlusError);
      expect(caught.code).to.equal("INVALID_ARGUMENT");
      expect(handlerCalled).to.be.false;
    });

    it("decorates legacy write tools with confirmation schema and additionalProperties: false", function () {
      const legacyTool: ToolDefinition = {
        name: "write_item",
        description: "Legacy item creation",
        inputSchema: {
          type: "object",
          properties: {
            itemType: { type: "string" },
          },
        },
      };

      registry.register(legacyTool, async () => ({}));
      const list = registry.list();
      const registered = list.find((t) => t.name === "write_item");

      expect(registered).to.exist;
      expect(registered!.description).to.include("Plus 默认 dryRun=true");
      expect(registered!.inputSchema.properties).to.have.property("dryRun");
      expect(registered!.inputSchema.properties).to.have.property(
        "confirmationToken",
      );
      expect(registered!.inputSchema.properties).to.have.property(
        "idempotencyKey",
      );
      expect(registered!.inputSchema.additionalProperties).to.be.false;
      expect(registered!.annotations?.destructiveHint).to.be.true;
      expect(registered!.annotations?.readOnlyHint).to.be.false;
    });

    it("registers all standard PLUS_TOOLS with valid schema and correct hints", function () {
      for (const tool of PLUS_TOOLS) {
        registry.register(tool, async () => ({}));
      }
      const list = registry.list();
      expect(list.length).to.equal(PLUS_TOOLS.length);

      const findStandalone = list.find(
        (t) => t.name === "find_standalone_attachments",
      );
      expect(findStandalone?.annotations?.readOnlyHint).to.be.true;
      expect(findStandalone?.annotations?.destructiveHint).to.be.false;

      const recognize = list.find((t) => t.name === "recognize_pdfs");
      expect(recognize?.annotations?.destructiveHint).to.be.true;
      expect(recognize?.annotations?.openWorldHint).to.be.true;
    });
  });
});
