import { lookupIdentifier } from "./legacyOperations.ts";
import { version } from "../../package.json";
import { LEGACY_TOOLS } from "./legacyToolDefinitions.ts";
import {
  ToolRegistry,
  LEGACY_WRITE_TOOLS,
  PLUS_TOOLS,
  type ToolDefinition,
} from "./toolRegistry.ts";
import {
  PLUS_PREF_PREFIX,
  PLUS_PROTOCOL_VERSION,
  PlusError,
  publicError,
  fingerprint,
} from "./plusTypes.ts";
import { dispatchPlusTool, setLegacyExecutor } from "./plusRuntime.ts";
import { findStandaloneAttachments } from "./standaloneService.ts";

function redactLocalPaths(value: any): any {
  if (Array.isArray(value)) return value.map(redactLocalPaths);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
          !["filePath", "localPath", "apiKey", "authorization"].includes(key),
      )
      .map(([key, child]) => [key, redactLocalPaths(child)]),
  );
}

import {
  handleGetLibraries,
  handleSearchLibraries,
  handleSearch,
  handleGetItem,
  handleGetCollections,
  handleSearchCollections,
  handleGetCollectionDetails,
  handleGetCollectionItems,
  handleGetSubcollections,
  handleSearchFulltext,
  handleGetItemAbstract,
  handleCreateCollection,
  handleUpdateCollection,
  handleDeleteCollection,
  handleAddItemsToCollection,
  handleRemoveItemsFromCollection,
} from "./apiHandlers";
import { UnifiedContentExtractor } from "./unifiedContentExtractor";
import { SmartAnnotationExtractor } from "./smartAnnotationExtractor";
import { MCPSettingsService } from "./mcpSettingsService";
import { getSemanticSearchService, SemanticSearchService } from "./semantic";
import {
  commitNotifierQueue,
  createNotifierQueue,
  notifierSaveOptions,
  runSerializedWrite,
} from "./deferredNotifierCommitter";

export interface MCPRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: any;
}

export interface MCPResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
  sessionId?: string;
}

export interface MCPNotification {
  jsonrpc: "2.0";
  method: string;
  params?: any;
}

/**
 * Streamable HTTP-based MCP Server integrated into Zotero Plugin
 *
 * This provides a complete MCP (Model Context Protocol) server implementation
 * that runs directly within the Zotero plugin. AI clients can connect using
 * streamable HTTP requests for real-time bidirectional communication.
 *
 * Architecture: AI Client (streamable HTTP) ↔ Zotero Plugin (integrated MCP server)
 */
export class StreamableMCPServer {
  private isInitialized: boolean = false;
  private serverInfo = {
    name: "zotero-mcp-plus",
    version,
  };
  private registry = new ToolRegistry();

  constructor() {
    setLegacyExecutor((name, args) => this.executeLegacyTool(name, args));
    for (const definition of LEGACY_TOOLS) {
      this.registry.register(definition, (args) =>
        LEGACY_WRITE_TOOLS.has(definition.name)
          ? dispatchPlusTool(definition.name, args)
          : this.executeLegacyTool(definition.name, args),
      );
    }
    for (const definition of PLUS_TOOLS) {
      this.registry.register(definition, (args) =>
        dispatchPlusTool(definition.name, args),
      );
    }
  }

  /**
   * Handle incoming MCP requests and return HTTP response
   */
  async handleMCPRequest(requestBody: string): Promise<{
    status: number;
    statusText: string;
    headers: any;
    body: string;
  }> {
    let parsedRequest: unknown;

    try {
      parsedRequest = JSON.parse(requestBody);
    } catch (error) {
      ztoolkit.log(`[StreamableMCP] Parse error: ${error}`);

      const errorResponse: MCPResponse = {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32700,
          message: "Parse error",
        },
      };

      return {
        status: 400,
        statusText: "Bad Request",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify(errorResponse),
      };
    }

    try {
      if (Array.isArray(parsedRequest)) {
        const batchError = this.createError(
          null,
          -32600,
          "Invalid Request: batch requests are not supported",
        );
        return {
          status: 400,
          statusText: "Bad Request",
          headers: { "Content-Type": "application/json; charset=utf-8" },
          body: JSON.stringify(batchError),
        };
      }

      if (!parsedRequest || typeof parsedRequest !== "object") {
        const invalidRequest = this.createError(
          null,
          -32600,
          "Invalid Request",
        );
        return {
          status: 400,
          statusText: "Bad Request",
          headers: { "Content-Type": "application/json; charset=utf-8" },
          body: JSON.stringify(invalidRequest),
        };
      }

      const request = parsedRequest as MCPRequest;
      if (
        request.jsonrpc !== "2.0" ||
        (request.id !== undefined &&
          request.id !== null &&
          typeof request.id !== "string" &&
          typeof request.id !== "number") ||
        (typeof request.id === "number" && !Number.isFinite(request.id))
      ) {
        const invalid = this.createError(null, -32600, "Invalid Request");
        return {
          status: 400,
          statusText: "Bad Request",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(invalid),
        };
      }
      if (typeof request.method !== "string" || !request.method.trim()) {
        const invalidRequest = this.createError(
          null,
          -32600,
          "Invalid Request: method is required",
        );
        return {
          status: 400,
          statusText: "Bad Request",
          headers: { "Content-Type": "application/json; charset=utf-8" },
          body: JSON.stringify(invalidRequest),
        };
      }

      ztoolkit.log(`[StreamableMCP] Received: ${request.method}`);

      const response = await this.processRequest(request);

      if (response === null) {
        return {
          status: 202,
          statusText: "Accepted",
          headers: { "Content-Type": "application/json; charset=utf-8" },
          body: "",
        };
      }

      const status = this.getHttpStatusForResponse(response);
      return {
        status,
        statusText: status === 400 ? "Bad Request" : "OK",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify(response),
      };
    } catch (error) {
      ztoolkit.log(`[StreamableMCP] Error handling request: ${error}`);

      const errorResponse: MCPResponse = {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32603,
          message: "Internal error",
        },
      };

      return {
        status: 400,
        statusText: "Bad Request",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify(errorResponse),
      };
    }
  }

  /**
   * Process individual MCP requests
   */
  private async processRequest(
    request: MCPRequest,
  ): Promise<MCPResponse | null> {
    const isNotification = this.isNotificationRequest(request);

    if (isNotification) {
      switch (request.method) {
        case "initialized":
        case "notifications/initialized":
          this.isInitialized = true;
          ztoolkit.log("[StreamableMCP] Client initialized (notification)");
          return null;
        default:
          if (request.method.startsWith("notifications/")) {
            ztoolkit.log(
              `[StreamableMCP] Ignoring unsupported notification: ${request.method}`,
            );
            return null;
          }
          return this.createError(
            null,
            -32600,
            `Invalid Request: id is required for method ${request.method}`,
          );
      }
    }

    try {
      switch (request.method) {
        case "initialize":
          return this.handleInitialize(request);

        case "initialized":
        case "notifications/initialized":
          this.isInitialized = true;
          ztoolkit.log("[StreamableMCP] Client initialized");
          return this.createResponse(request.id ?? null, { success: true });

        case "tools/list":
          return this.handleToolsList(request);

        case "tools/call":
          return await this.handleToolCall(request);

        case "resources/list":
          return this.handleResourcesList(request);

        case "prompts/list":
          return this.handlePromptsList(request);

        case "ping":
          return this.handlePing(request);

        default:
          return this.createError(
            request.id ?? null,
            -32601,
            `Method not found: ${request.method}`,
          );
      }
    } catch (error) {
      ztoolkit.log(
        `[StreamableMCP] Error processing ${request.method}: ${error}`,
      );
      return this.createError(request.id ?? null, -32603, "Internal error");
    }
  }

  private handleInitialize(request: MCPRequest): MCPResponse {
    if (typeof request.params?.protocolVersion !== "string") {
      return this.createError(request.id ?? null, -32602, "缺少协议版本");
    }
    return this.createResponse(request.id ?? null, {
      protocolVersion: PLUS_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: this.serverInfo,
      instructions:
        "文库修改默认只预览。必须先向用户展示副作用并得到确认，才能携带 confirmationToken 和 idempotencyKey 执行。任务成功与否以逐项结果为准。",
    });
  }

  private handleResourcesList(request: MCPRequest): MCPResponse {
    // Return empty resources list - we don't currently support resources
    return this.createResponse(request.id ?? null, { resources: [] });
  }

  private handlePromptsList(request: MCPRequest): MCPResponse {
    // Return empty prompts list - we don't currently support prompts
    return this.createResponse(request.id ?? null, { prompts: [] });
  }

  private handlePing(request: MCPRequest): MCPResponse {
    // Standard MCP ping response - just return empty result
    return this.createResponse(request.id ?? null, {});
  }

  private getHttpStatusForResponse(response: MCPResponse): number {
    if (!response.error) {
      return 200;
    }

    // Align transport status for structural request errors.
    if (response.error.code === -32600 || response.error.code === -32700) {
      return 400;
    }

    return 200;
  }

  public listTools(): ToolDefinition[] {
    return this.registry.list();
  }

  private handleToolsList(request: MCPRequest): MCPResponse {
    return this.createResponse(request.id ?? null, { tools: this.listTools() });
  }

  private async handleToolCall(request: MCPRequest): Promise<MCPResponse> {
    const name = request.params?.name;
    if (typeof name !== "string")
      return this.createError(request.id ?? null, -32602, "工具名无效");
    try {
      const result = redactLocalPaths(
        await this.registry.call(name, request.params.arguments ?? {}),
      );
      const isError = result?.success === false || Boolean(result?.error);
      return this.createResponse(request.id ?? null, {
        content: [
          {
            type: "text",
            text: typeof result === "string" ? result : JSON.stringify(result),
          },
        ],
        ...(result && typeof result === "object" && !Array.isArray(result)
          ? { structuredContent: result }
          : {}),
        isError,
      });
    } catch (error) {
      const detail = publicError(error);
      return this.createResponse(request.id ?? null, {
        content: [
          {
            type: "text",
            text: JSON.stringify({ success: false, error: detail }),
          },
        ],
        structuredContent: { success: false, error: detail },
        isError: true,
      });
    }
  }

  private async executeLegacyTool(name: string, args: any): Promise<any> {
    const handlers: Record<string, (args: any) => Promise<any>> = {
      get_libraries: (args) => this.callGetLibraries(args),
      search_library: (args) => this.callSearchLibrary(args),
      search_libraries: (args) => this.callSearchLibraries(args),
      search_annotations: (args) => this.callSearchAnnotations(args),
      get_item_details: (args) => this.callGetItemDetails(args),
      get_annotations: (args) => this.callGetAnnotations(args),
      get_content: (args) => this.callGetContent(args),
      get_collections: (args) => this.callGetCollections(args),
      search_collections: (args) => this.callSearchCollections(args),
      get_collection_details: (args) => this.callGetCollectionDetails(args),
      get_collection_items: (args) => this.callGetCollectionItems(args),
      get_subcollections: (args) => this.callGetSubcollections(args),
      create_collection: (args) => this.callCreateCollection(args),
      update_collection: (args) => this.callUpdateCollection(args),
      delete_collection: (args) => this.callDeleteCollection(args),
      add_items_to_collection: (args) => this.callAddItemsToCollection(args),
      remove_items_from_collection: (args) =>
        this.callRemoveItemsFromCollection(args),
      search_fulltext: (args) => this.callSearchFulltext(args),
      get_item_abstract: (args) => this.callGetItemAbstract(args),
      semantic_search: (args) => this.callSemanticSearch(args),
      find_similar: (args) => this.callFindSimilar(args),
      semantic_status: () => this.callSemanticStatus(),
      fulltext_database: (args) => this.callFulltextDatabase(args),
      write_note: (args) => this.callWriteNote(args),
      write_tag: (args) => this.callWriteTag(args),
      write_metadata: (args) => this.callWriteMetadata(args),
      write_item: (args) => this.callWriteItem(args),
      add_by_identifier: (args) => this.callAddByIdentifier(args),
    };
    if (!handlers[name]) throw new PlusError("UNKNOWN_TOOL", "未知工具");
    if (
      ["semantic_search", "find_similar", "semantic_status"].includes(name) &&
      Zotero.Prefs.get(`${PLUS_PREF_PREFIX}.semantic.enabled`, true) !== true
    ) {
      throw new PlusError(
        "FEATURE_DISABLED",
        "语义检索默认关闭；需在本地设置提供方后显式启用",
      );
    }
    return handlers[name](args);
  }

  private async callGetLibraries(args: any): Promise<any> {
    const queryParams = new URLSearchParams();
    for (const [key, value] of Object.entries(args || {})) {
      if (value !== undefined && value !== null) {
        queryParams.append(key, String(value));
      }
    }

    const response = await handleGetLibraries(queryParams);
    const result = response.body ? JSON.parse(response.body) : response;
    return result;
  }

  private async callSearchLibraries(args: any): Promise<any> {
    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(args || {})) {
      if (value !== undefined && value !== null) {
        searchParams.append(key, String(value));
      }
    }
    const response = await handleSearchLibraries(searchParams);
    const result = response.body ? JSON.parse(response.body) : response;
    return result;
  }

  private async callSearchLibrary(args: any): Promise<any> {
    if (args.itemType === "attachment") {
      if (args.includeAttachments === "false") {
        return {
          items: [],
          results: [],
          data: [],
          total: 0,
          scannedCount: 0,
          complete: true,
        };
      }
      const found = await findStandaloneAttachments(
        {
          ...args,
          sort: args.sort === "title" ? "title" : "dateAdded",
          limit: Math.min(args.limit ?? 50, 100),
        },
        { pdfOnly: false },
      );
      const items = found.items.map((item: any) => ({
        ...item,
        itemKey: item.key,
        itemType: "attachment",
      }));
      return { ...found, items, results: items, data: items };
    }
    // Apply mode-based defaults before creating search params
    const effectiveMode = args.mode || MCPSettingsService.get("content.mode");
    const modeConfig = this.getSearchModeConfiguration(effectiveMode);

    // Apply mode defaults if not explicitly provided
    const processedArgs = {
      ...args,
      limit: args.limit || modeConfig.limit,
    };

    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(processedArgs)) {
      if (value !== undefined && value !== null) {
        if (key !== "mode") {
          // Don't pass mode to API
          searchParams.append(key, String(value));
        }
      }
    }

    const SEARCH_TIMEOUT_MS = 25000; // 25 秒超时，低于 keepAlive 的 30 秒
    const searchPromise = handleSearch(searchParams);
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(
        () =>
          reject(
            new Error(
              "Search timed out after 25 seconds. Try narrowing your query or reducing the limit.",
            ),
          ),
        SEARCH_TIMEOUT_MS,
      );
    });
    const response = await Promise.race([searchPromise, timeoutPromise]);
    const result = response.body ? JSON.parse(response.body) : response;

    // Add mode information to metadata
    if (result && typeof result === "object") {
      result.metadata = {
        ...result.metadata,
        mode: effectiveMode,
        appliedModeConfig: modeConfig,
      };

      // Remove any unwanted content array if it's empty
      if (Array.isArray(result.content) && result.content.length === 0) {
        delete result.content;
      }
    }

    return result;
  }

  private async callSearchAnnotations(args: any): Promise<any> {
    const extractor = new SmartAnnotationExtractor();
    const { q, ...options } = args;
    const result = await extractor.searchAnnotations(q, options);
    return result;
  }

  private async callGetItemDetails(args: any): Promise<any> {
    const { itemKey, mode, libraryID } = args;

    // Import the specific handler for item details
    const { handleGetItem } = await import("./apiHandlers");

    // Get effective mode
    const effectiveMode = mode || MCPSettingsService.get("content.mode");

    // Create query params with mode-based field selection
    const queryParams = new URLSearchParams();
    if (libraryID !== undefined && libraryID !== null) {
      queryParams.append("libraryID", String(libraryID));
    }
    if (effectiveMode !== "complete") {
      // Apply field filtering based on mode (this could be enhanced in apiHandlers)
      const modeConfig = this.getItemDetailsModeConfiguration(effectiveMode);
      if (modeConfig.fields) {
        queryParams.append("fields", modeConfig.fields.join(","));
      }
    }

    // Call the dedicated item details handler
    const response = await handleGetItem({ 1: itemKey }, queryParams);
    const result = response.body ? JSON.parse(response.body) : response;

    // complete mode: additionally include the item's full Zotero API JSON
    // (dateAdded/dateModified, collections, relations, extra) so complete is
    // a strict superset of standard instead of identical to it (#96)
    if (
      effectiveMode === "complete" &&
      result &&
      typeof result === "object" &&
      !result.error
    ) {
      try {
        const resolvedLibraryID =
          libraryID !== undefined && libraryID !== null
            ? Number(libraryID)
            : Zotero.Libraries.userLibraryID;
        const item = await Zotero.Items.getByLibraryAndKeyAsync(
          resolvedLibraryID,
          itemKey,
        );
        if (item) {
          result.apiJSON = item.toJSON();
        }
      } catch (e) {
        ztoolkit.log(
          `[StreamableMCP] get_item_details complete-mode toJSON failed: ${e}`,
          "warn",
        );
      }
    }

    // Add mode information to metadata
    if (result && typeof result === "object") {
      result.metadata = {
        ...result.metadata,
        mode: effectiveMode,
        appliedModeConfig: this.getItemDetailsModeConfiguration(effectiveMode),
      };
    }

    return result;
  }

  private async callGetAnnotations(args: any): Promise<any> {
    const extractor = new SmartAnnotationExtractor();
    const result = await extractor.getAnnotations(args);
    return result;
  }

  private async callGetContent(args: any): Promise<any> {
    const {
      itemKey,
      attachmentKey,
      include,
      format,
      mode,
      contentControl,
      libraryID,
    } = args;
    const extractor = new UnifiedContentExtractor();

    try {
      let result;

      if (itemKey) {
        // Get content from item with unified mode control and content control parameters
        result = await extractor.getItemContent(
          itemKey,
          include || {},
          mode,
          contentControl,
          libraryID,
        );
      } else if (attachmentKey) {
        // Get content from specific attachment with unified mode control and content control parameters
        result = await extractor.getAttachmentContent(
          attachmentKey,
          mode,
          contentControl,
          libraryID,
        );
      } else {
        throw new Error("Either itemKey or attachmentKey must be provided");
      }

      // Apply format conversion if requested
      if (format === "text" && itemKey) {
        return extractor.convertToText(result);
      } else if (format === "text" && attachmentKey) {
        return result.content || "";
      }

      return result;
    } catch (error) {
      ztoolkit.log(
        `[StreamableMCP] Error in callGetContent: ${error}`,
        "error",
      );
      throw error;
    }
  }

  private async callGetCollections(args: any): Promise<any> {
    // Apply mode-based defaults before creating search params
    const effectiveMode = args.mode || MCPSettingsService.get("content.mode");
    const modeConfig = this.getCollectionModeConfiguration(effectiveMode);

    // Apply mode defaults if not explicitly provided
    const processedArgs = {
      ...args,
      limit: args.limit || modeConfig.limit,
    };

    const collectionParams = new URLSearchParams();
    for (const [key, value] of Object.entries(processedArgs)) {
      if (value !== undefined && value !== null) {
        if (key !== "mode") {
          // Don't pass mode to API
          collectionParams.append(key, String(value));
        }
      }
    }

    const response = await handleGetCollections(collectionParams);
    const result = response.body ? JSON.parse(response.body) : response;

    // Add mode information to metadata
    if (result && typeof result === "object") {
      result.metadata = {
        ...result.metadata,
        mode: effectiveMode,
        appliedModeConfig: modeConfig,
      };
    }

    return result;
  }

  private async callSearchCollections(args: any): Promise<any> {
    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(args || {})) {
      if (value !== undefined && value !== null) {
        searchParams.append(key, String(value));
      }
    }
    const response = await handleSearchCollections(searchParams);
    const result = response.body ? JSON.parse(response.body) : response;
    return result;
  }

  private async callGetCollectionDetails(args: any): Promise<any> {
    const { collectionKey, ...otherArgs } = args;
    const detailParams = new URLSearchParams();
    for (const [key, value] of Object.entries(otherArgs)) {
      if (value !== undefined && value !== null) {
        detailParams.append(key, String(value));
      }
    }
    const response = await handleGetCollectionDetails(
      { 1: collectionKey },
      detailParams,
    );
    const result = response.body ? JSON.parse(response.body) : response;
    return result;
  }

  private async callGetCollectionItems(args: any): Promise<any> {
    const { collectionKey, ...otherArgs } = args;
    const itemParams = new URLSearchParams();
    for (const [key, value] of Object.entries(otherArgs)) {
      if (value !== undefined && value !== null) {
        itemParams.append(key, String(value));
      }
    }
    const response = await handleGetCollectionItems(
      { 1: collectionKey },
      itemParams,
    );
    const result = response.body ? JSON.parse(response.body) : response;
    return result;
  }

  private async callGetSubcollections(args: any): Promise<any> {
    const { collectionKey, ...otherArgs } = args;
    const subcollectionParams = new URLSearchParams();
    for (const [key, value] of Object.entries(otherArgs)) {
      if (value !== undefined && value !== null) {
        subcollectionParams.append(key, String(value));
      }
    }
    const response = await handleGetSubcollections(
      { 1: collectionKey },
      subcollectionParams,
    );
    const result = response.body ? JSON.parse(response.body) : response;
    return result;
  }

  private async callCreateCollection(args: any): Promise<any> {
    const response = await handleCreateCollection({
      libraryID: args.libraryID,
      name: args.name,
      parentCollection: args.parentCollection,
    });
    return response.body ? JSON.parse(response.body) : response;
  }

  private async callUpdateCollection(args: any): Promise<any> {
    const { collectionKey, ...body } = args;
    const response = await handleUpdateCollection({ 1: collectionKey }, body);
    return response.body ? JSON.parse(response.body) : response;
  }

  private async callDeleteCollection(args: any): Promise<any> {
    const { collectionKey, ...body } = args;
    const response = await handleDeleteCollection({ 1: collectionKey }, body);
    return response.body ? JSON.parse(response.body) : response;
  }

  /**
   * Accept arrays that some MCP clients serialize as strings, e.g.
   * '["KEY1","KEY2"]' or 'KEY1,KEY2' (#71).
   */
  private coerceStringArray(value: unknown): string[] | undefined {
    if (Array.isArray(value)) {
      return value.map(String);
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.startsWith("[")) {
        try {
          const parsed = JSON.parse(trimmed);
          if (Array.isArray(parsed)) return parsed.map(String);
        } catch {
          // fall through to comma-split
        }
      }
      if (trimmed.length > 0) {
        return trimmed
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      }
    }
    return undefined;
  }

  private async callAddItemsToCollection(args: any): Promise<any> {
    const { collectionKey, itemKeys, libraryID } = args;
    const response = await handleAddItemsToCollection(
      { 1: collectionKey },
      { itemKeys, libraryID },
    );
    return response.body ? JSON.parse(response.body) : response;
  }

  private async callRemoveItemsFromCollection(args: any): Promise<any> {
    const { collectionKey, itemKeys, libraryID } = args;
    const response = await handleRemoveItemsFromCollection(
      { 1: collectionKey },
      { itemKeys, libraryID },
    );
    return response.body ? JSON.parse(response.body) : response;
  }

  private async callSearchFulltext(args: any): Promise<any> {
    // Apply mode-based defaults before creating search params
    const effectiveMode = args.mode || MCPSettingsService.get("content.mode");
    const modeConfig = this.getFulltextModeConfiguration(effectiveMode);

    // Apply mode defaults if not explicitly provided
    const processedArgs = {
      ...args,
      contextLength: args.contextLength || modeConfig.contextLength,
      maxResults: args.maxResults || modeConfig.maxResults,
    };

    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(processedArgs)) {
      if (value !== undefined && value !== null) {
        if (key === "itemKeys" && Array.isArray(value)) {
          searchParams.append(key, value.join(","));
        } else if (key !== "mode") {
          // Don't pass mode to API
          searchParams.append(key, String(value));
        }
      }
    }

    const response = await handleSearchFulltext(searchParams);
    const result = response.body ? JSON.parse(response.body) : response;

    // Add mode information to metadata
    if (result && typeof result === "object") {
      result.metadata = {
        ...result.metadata,
        mode: effectiveMode,
        appliedModeConfig: modeConfig,
      };
    }

    return result;
  }

  private async callGetItemAbstract(args: any): Promise<any> {
    const { itemKey, ...otherArgs } = args;
    const abstractParams = new URLSearchParams();
    for (const [key, value] of Object.entries(otherArgs)) {
      if (value !== undefined && value !== null) {
        abstractParams.append(key, String(value));
      }
    }
    const response = await handleGetItemAbstract(
      { 1: itemKey },
      abstractParams,
    );
    const contentType = response.headers?.["Content-Type"] || "";
    if (contentType.startsWith("text/plain")) {
      // format=text returns a plain-text body that must not be JSON.parsed
      return response.body;
    }
    const result = response.body ? JSON.parse(response.body) : response;
    return result;
  }

  // ============ Semantic Search Methods ============

  private async callSemanticSearch(args: any): Promise<any> {
    try {
      const semanticService = getSemanticSearchService();
      await semanticService.initialize();

      const results = await semanticService.search(args.query, {
        topK: args.topK,
        minScore: args.minScore,
        language: args.language,
      });

      const response = {
        mode: "semantic",
        query: args.query,
        data: results,
        metadata: {
          extractedAt: new Date().toISOString(),
          searchMode: "semantic",
          resultCount: results.length,
          fallbackMode:
            semanticService.getIndexProgress().status === "idle"
              ? (await semanticService.getStats()).serviceStatus.fallbackMode
              : false,
        },
      };

      return response;
    } catch (error) {
      ztoolkit.log(`[StreamableMCP] Semantic search error: ${error}`, "error");
      throw error;
    }
  }

  private async callFindSimilar(args: any): Promise<any> {
    try {
      const semanticService = getSemanticSearchService();
      await semanticService.initialize();

      const results = await semanticService.findSimilar(args.itemKey, {
        topK: args.topK,
        minScore: args.minScore,
      });

      const response = {
        mode: "similar",
        sourceItemKey: args.itemKey,
        data: results,
        metadata: {
          extractedAt: new Date().toISOString(),
          resultCount: results.length,
        },
      };

      return response;
    } catch (error) {
      ztoolkit.log(`[StreamableMCP] Find similar error: ${error}`, "error");
      throw error;
    }
  }

  private async callSemanticStatus(): Promise<any> {
    try {
      const semanticService = getSemanticSearchService();
      const isReady = await semanticService.isReady();
      const stats = isReady ? await semanticService.getStats() : null;
      const progress = semanticService.getIndexProgress();

      // Check Int8 migration status
      let int8Status = null;
      try {
        const { getVectorStore } = await import("./semantic/vectorStore");
        const vectorStore = getVectorStore();
        await vectorStore.initialize();
        int8Status = await vectorStore.needsInt8Migration();
      } catch (e) {
        // Ignore if vector store not available
      }

      let message = !isReady
        ? "Semantic search service not initialized"
        : stats?.serviceStatus.fallbackMode
          ? "Running in fallback mode (API not configured)"
          : `Semantic search ready with ${stats?.indexStats.totalItems || 0} indexed items`;

      // Add Int8 migration suggestion if needed
      if (int8Status?.needed) {
        message += `. WARNING: ${int8Status.count}/${int8Status.total} vectors need Int8 migration for ~6x faster search. Run migrate_int8 to optimize.`;
      }

      return {
        ready: isReady,
        initialized: stats?.serviceStatus.initialized || false,
        fallbackMode: stats?.serviceStatus.fallbackMode || false,
        indexProgress: progress,
        indexStats: stats?.indexStats || null,
        int8Migration: int8Status,
        message,
      };
    } catch (error) {
      ztoolkit.log(`[StreamableMCP] Semantic status error: ${error}`, "error");
      return {
        ready: false,
        error: String(error),
      };
    }
  }

  private async callFulltextDatabase(args: any): Promise<any> {
    try {
      const { getVectorStore } = await import("./semantic/vectorStore");
      const vectorStore = getVectorStore();
      await vectorStore.initialize();

      const {
        action,
        query,
        itemKeys,
        limit = 20,
        caseSensitive = false,
      } = args;

      switch (action) {
        case "list": {
          const cachedItems = await vectorStore.listCachedContent();
          const limitedItems = cachedItems.slice(0, limit);

          return {
            action: "list",
            data: limitedItems,
            metadata: {
              extractedAt: new Date().toISOString(),
              totalCached: cachedItems.length,
              returned: limitedItems.length,
              message: `Found ${cachedItems.length} items in full-text database`,
            },
          };
        }

        case "search": {
          if (!query) {
            throw new Error("query is required for search action");
          }

          const searchResults = await vectorStore.searchCachedContent(query, {
            limit,
            caseSensitive,
          });

          return {
            action: "search",
            query,
            data: searchResults,
            metadata: {
              extractedAt: new Date().toISOString(),
              resultCount: searchResults.length,
              caseSensitive,
              message: `Found ${searchResults.length} items matching "${query}"`,
            },
          };
        }

        case "get": {
          if (!itemKeys || itemKeys.length === 0) {
            throw new Error("itemKeys is required for get action");
          }

          const contentMap = await vectorStore.getFullContentBatch(itemKeys);
          const results: Array<{
            itemKey: string;
            content: string | null;
            contentLength: number;
          }> = [];

          for (const key of itemKeys) {
            const content = contentMap.get(key) || null;
            results.push({
              itemKey: key,
              content,
              contentLength: content ? content.length : 0,
            });
          }

          return {
            action: "get",
            data: results,
            metadata: {
              extractedAt: new Date().toISOString(),
              requested: itemKeys.length,
              found: results.filter((r) => r.content !== null).length,
              message: `Retrieved content for ${results.filter((r) => r.content !== null).length}/${itemKeys.length} items`,
            },
          };
        }

        case "stats": {
          const stats = await vectorStore.getStats();

          // Format size nicely
          const formatSize = (bytes: number) => {
            if (bytes < 1024) return `${bytes} B`;
            if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
            return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
          };

          return {
            action: "stats",
            data: {
              cachedItems: stats.cachedContentItems,
              cachedContentSize: stats.cachedContentSizeBytes,
              cachedContentSizeFormatted: formatSize(
                stats.cachedContentSizeBytes,
              ),
              indexedItems: stats.totalItems,
              totalVectors: stats.totalVectors,
              zhVectors: stats.zhVectors,
              enVectors: stats.enVectors,
            },
            metadata: {
              extractedAt: new Date().toISOString(),
              message: `Full-text database: ${stats.cachedContentItems} items, ${formatSize(stats.cachedContentSizeBytes)}`,
            },
          };
        }

        default:
          throw new Error(
            `Unknown action: ${action}. Use list, search, get, or stats. Database management is done through Zotero preferences.`,
          );
      }
    } catch (error) {
      ztoolkit.log(
        `[StreamableMCP] Fulltext database error: ${error}`,
        "error",
      );
      return {
        success: false,
        error: String(error),
      };
    }
  }

  /**
   * Convert Markdown content to HTML suitable for Zotero notes.
   * Auto-detects if content is already HTML and skips conversion.
   */
  private markdownToNoteHtml(markdown: string): string {
    if (!markdown || typeof markdown !== "string") return "";

    // Detect if content is already HTML
    const trimmed = markdown.trim();
    if (trimmed.startsWith("<") && /<\/.+>/.test(trimmed)) {
      return markdown;
    }

    let html = markdown;

    // Escape HTML entities
    html = html
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    // Headings (process longest first)
    html = html.replace(/^######\s+(.+)$/gm, "<h6>$1</h6>");
    html = html.replace(/^#####\s+(.+)$/gm, "<h5>$1</h5>");
    html = html.replace(/^####\s+(.+)$/gm, "<h4>$1</h4>");
    html = html.replace(/^###\s+(.+)$/gm, "<h3>$1</h3>");
    html = html.replace(/^##\s+(.+)$/gm, "<h2>$1</h2>");
    html = html.replace(/^#\s+(.+)$/gm, "<h1>$1</h1>");

    // Bold + italic, bold, italic
    html = html.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
    html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");

    // Inline code
    html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

    // Links
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

    // Horizontal rules
    html = html.replace(/^---+$/gm, "<hr/>");

    // Unordered lists (block)
    html = html.replace(/(?:^[-*+]\s+.+$\n?)+/gm, (match) => {
      const items = match
        .trim()
        .split("\n")
        .map((line: string) => {
          const content = line.replace(/^[-*+]\s+/, "");
          return `<li>${content}</li>`;
        })
        .join("");
      return `<ul>${items}</ul>\n`;
    });

    // Ordered lists (block)
    html = html.replace(/(?:^\d+\.\s+.+$\n?)+/gm, (match) => {
      const items = match
        .trim()
        .split("\n")
        .map((line: string) => {
          const content = line.replace(/^\d+\.\s+/, "");
          return `<li>${content}</li>`;
        })
        .join("");
      return `<ol>${items}</ol>\n`;
    });

    // Paragraphs: split by double newline, wrap plain text blocks in <p>
    const blocks = html.split(/\n\n+/);
    html = blocks
      .map((block: string) => {
        block = block.trim();
        if (!block) return "";
        if (/^<(h[1-6]|ul|ol|li|blockquote|hr|div|p|pre|table)/i.test(block)) {
          return block;
        }
        block = block.replace(/\n/g, "<br/>");
        return `<p>${block}</p>`;
      })
      .filter(Boolean)
      .join("\n");

    return html;
  }

  /**
   * Handle write_note tool calls: create, update, append notes
   */
  private async callWriteNote(args: any): Promise<any> {
    const {
      action,
      parentKey,
      noteKey,
      content,
      tags,
      libraryID = Zotero.Libraries.userLibraryID,
    } = args;

    try {
      const htmlContent = this.markdownToNoteHtml(content);

      switch (action) {
        case "create": {
          const note = new Zotero.Item("note");
          note.libraryID = libraryID;

          if (parentKey) {
            const parentItem = await Zotero.Items.getByLibraryAndKeyAsync(
              libraryID,
              parentKey,
            );
            if (!parentItem) {
              throw new Error(
                `Parent item not found in library ${libraryID}: ${parentKey}`,
              );
            }
            if (parentItem.isNote()) {
              throw new Error("Cannot attach a note to another note");
            }
            if (parentItem.isAttachment()) {
              throw new Error("Cannot attach a note to an attachment");
            }
            note.parentKey = parentKey;
          }

          note.setNote(htmlContent);

          if (tags && Array.isArray(tags)) {
            for (const tag of tags) {
              note.addTag(tag, 0);
            }
          }

          const notifierQueue = createNotifierQueue();
          await note.saveTx(notifierSaveOptions(notifierQueue));
          const notification = await commitNotifierQueue(
            notifierQueue,
            `create note ${note.key}`,
          );

          ztoolkit.log(
            `[StreamableMCP] Created note ${note.key}${parentKey ? " attached to " + parentKey : " (standalone)"}`,
          );

          return {
            action: "create",
            success: true,
            data: {
              noteKey: note.key,
              verificationHash: await fingerprint(note.getNote()),
              parentKey: parentKey || null,
              type: parentKey ? "child" : "standalone",
              contentPreview: content.substring(0, 200),
              contentLength: content.length,
              tags: tags || [],
              dateCreated: note.dateAdded,
            },
            metadata: {
              extractedAt: new Date().toISOString(),
              notificationStatus: notification.status,
              message: `Note created successfully (key: ${note.key})`,
            },
          };
        }

        case "update": {
          if (!noteKey) {
            throw new Error("noteKey is required for update action");
          }

          const existingNote = await Zotero.Items.getByLibraryAndKeyAsync(
            libraryID,
            noteKey,
          );
          if (!existingNote) {
            throw new Error(
              `Note not found in library ${libraryID}: ${noteKey}`,
            );
          }
          if (!existingNote.isNote()) {
            throw new Error(`Item ${noteKey} is not a note`);
          }

          existingNote.setNote(htmlContent);

          if (tags && Array.isArray(tags)) {
            for (const tag of tags) {
              existingNote.addTag(tag, 0);
            }
          }

          const notifierQueue = createNotifierQueue();
          await existingNote.saveTx(notifierSaveOptions(notifierQueue));
          const notification = await commitNotifierQueue(
            notifierQueue,
            `update note ${noteKey}`,
          );

          ztoolkit.log(`[StreamableMCP] Updated note ${noteKey}`);

          return {
            action: "update",
            success: true,
            data: {
              noteKey,
              verificationHash: await fingerprint(existingNote.getNote()),
              contentPreview: content.substring(0, 200),
              contentLength: content.length,
              tags: existingNote.getTags().map((t: any) => t.tag),
              dateModified: existingNote.dateModified,
            },
            metadata: {
              extractedAt: new Date().toISOString(),
              notificationStatus: notification.status,
              message: `Note ${noteKey} updated successfully`,
            },
          };
        }

        case "append": {
          if (!noteKey) {
            throw new Error("noteKey is required for append action");
          }

          const existingNote = await Zotero.Items.getByLibraryAndKeyAsync(
            libraryID,
            noteKey,
          );
          if (!existingNote) {
            throw new Error(
              `Note not found in library ${libraryID}: ${noteKey}`,
            );
          }
          if (!existingNote.isNote()) {
            throw new Error(`Item ${noteKey} is not a note`);
          }

          const currentHtml = existingNote.getNote() || "";
          const appendedHtml = currentHtml + htmlContent;
          existingNote.setNote(appendedHtml);

          if (tags && Array.isArray(tags)) {
            for (const tag of tags) {
              existingNote.addTag(tag, 0);
            }
          }

          const notifierQueue = createNotifierQueue();
          await existingNote.saveTx(notifierSaveOptions(notifierQueue));
          const notification = await commitNotifierQueue(
            notifierQueue,
            `append note ${noteKey}`,
          );

          ztoolkit.log(`[StreamableMCP] Appended to note ${noteKey}`);

          return {
            action: "append",
            success: true,
            data: {
              noteKey,
              verificationHash: await fingerprint(existingNote.getNote()),
              appendedContentPreview: content.substring(0, 200),
              appendedContentLength: content.length,
              totalContentLength: appendedHtml.length,
              tags: existingNote.getTags().map((t: any) => t.tag),
              dateModified: existingNote.dateModified,
            },
            metadata: {
              extractedAt: new Date().toISOString(),
              notificationStatus: notification.status,
              message: `Content appended to note ${noteKey} successfully`,
            },
          };
        }

        default:
          throw new Error(
            `Unknown action: ${action}. Use create, update, or append.`,
          );
      }
    } catch (error) {
      ztoolkit.log(`[StreamableMCP] Write note error: ${error}`, "error");
      return {
        success: false,
        error: String(error),
      };
    }
  }

  /**
   * Handle write_tag tool calls: add, remove, set tags on items
   */
  private async callWriteTag(args: any): Promise<any> {
    const {
      action,
      itemKey,
      tags,
      libraryID = Zotero.Libraries.userLibraryID,
    } = args;

    try {
      const item = await Zotero.Items.getByLibraryAndKeyAsync(
        libraryID,
        itemKey,
      );
      if (!item) {
        throw new Error(`Item not found in library ${libraryID}: ${itemKey}`);
      }

      const beforeTags = item.getTags().map((t: any) => t.tag);

      switch (action) {
        case "add": {
          for (const tag of tags) {
            item.addTag(tag, 0);
          }
          break;
        }

        case "remove": {
          for (const tag of tags) {
            item.removeTag(tag);
          }
          break;
        }

        case "set": {
          // Remove all existing tags
          for (const existing of beforeTags) {
            item.removeTag(existing);
          }
          // Add new tags
          for (const tag of tags) {
            item.addTag(tag, 0);
          }
          break;
        }

        default:
          throw new Error(
            `Unknown action: ${action}. Use add, remove, or set.`,
          );
      }

      const notifierQueue = createNotifierQueue();
      await item.saveTx(notifierSaveOptions(notifierQueue));
      const notification = await commitNotifierQueue(
        notifierQueue,
        `write tags on ${itemKey}`,
      );

      const afterTags = item.getTags().map((t: any) => t.tag);

      ztoolkit.log(`[StreamableMCP] write_tag completed: ${action}`);

      return {
        action,
        success: true,
        data: {
          itemKey,
          beforeTags,
          afterTags,
          tagsModified: tags,
        },
        metadata: {
          extractedAt: new Date().toISOString(),
          notificationStatus: notification.status,
          message: `Tags ${action === "add" ? "added to" : action === "remove" ? "removed from" : "set on"} item ${itemKey}`,
        },
      };
    } catch (error) {
      ztoolkit.log(`[StreamableMCP] Write tag error: ${error}`, "error");
      return {
        success: false,
        error: String(error),
      };
    }
  }

  /**
   * Handle write_metadata tool calls: update fields and creators on items
   */
  private async callWriteMetadata(args: any): Promise<any> {
    const { itemKey, fields, creators } = args;
    const libraryID =
      args.libraryID === 0 ||
      args.libraryID === undefined ||
      args.libraryID === null
        ? Zotero.Libraries.userLibraryID
        : args.libraryID;

    try {
      const item = await Zotero.Items.getByLibraryAndKeyAsync(
        libraryID,
        itemKey,
      );
      if (!item) {
        throw new Error(`Item not found in library ${libraryID}: ${itemKey}`);
      }
      if (!item.isRegularItem()) {
        throw new Error(
          `Item ${itemKey} is not a regular item (it is a ${item.itemType}). Use write_note for notes.`,
        );
      }

      const updatedFields: Record<string, { before: string; after: string }> =
        {};
      let creatorsUpdated = false;
      let beforeCreators: any[] = [];
      let afterCreators: any[] = [];

      // Update fields
      if (fields && typeof fields === "object") {
        for (const [fieldName, value] of Object.entries(fields)) {
          try {
            const before = String(item.getField(fieldName) || "");
            item.setField(fieldName, String(value));
            updatedFields[fieldName] = { before, after: String(value) };
          } catch (fieldError) {
            throw new Error(
              `Failed to set field "${fieldName}": ${fieldError}`,
            );
          }
        }
      }

      // Update creators
      if (creators && Array.isArray(creators)) {
        beforeCreators = item.getCreators().map((c: any) => ({
          creatorType: Zotero.CreatorTypes.getName(c.creatorTypeID),
          firstName: c.firstName,
          lastName: c.lastName,
        }));

        item.setCreators(
          creators.map((c: any) => {
            const creatorData: any = {
              creatorType: c.creatorType || "author",
            };
            if (c.name) {
              // Organization / single-field name
              creatorData.name = c.name;
            } else {
              creatorData.firstName = c.firstName || "";
              creatorData.lastName = c.lastName || "";
            }
            return creatorData;
          }),
        );

        creatorsUpdated = true;
        afterCreators = creators;
      }

      const notifierQueue = createNotifierQueue();
      await item.saveTx(notifierSaveOptions(notifierQueue));
      const notification = await commitNotifierQueue(
        notifierQueue,
        `update metadata on ${itemKey}`,
      );

      ztoolkit.log(
        `[StreamableMCP] Updated metadata on ${itemKey}: fields=[${Object.keys(updatedFields).join(", ")}], creators=${creatorsUpdated}`,
      );

      return {
        success: true,
        data: {
          itemKey,
          updatedFields,
          creatorsUpdated,
          ...(creatorsUpdated ? { beforeCreators, afterCreators } : {}),
        },
        metadata: {
          extractedAt: new Date().toISOString(),
          notificationStatus: notification.status,
          message: `Metadata updated on item ${itemKey}`,
        },
      };
    } catch (error) {
      ztoolkit.log(`[StreamableMCP] Write metadata error: ${error}`, "error");
      return {
        success: false,
        error: String(error),
      };
    }
  }

  /**
   * Handle write_item tool calls: create items, reparent attachments, and import files
   */
  private async callWriteItem(args: any): Promise<any> {
    const {
      action,
      itemType,
      fields,
      creators,
      tags,
      attachmentKeys,
      parentKey,
      filePath,
      parentItemKey,
      title,
      libraryID = Zotero.Libraries.userLibraryID,
    } = args;

    try {
      switch (action) {
        case "create": {
          if (!itemType) {
            throw new Error(
              "itemType is required for create action (e.g., journalArticle, book, conferencePaper)",
            );
          }

          // Create new item
          const item = new Zotero.Item(itemType);
          item.libraryID = libraryID;

          // Set fields
          if (fields && typeof fields === "object") {
            for (const [fieldName, value] of Object.entries(fields)) {
              try {
                item.setField(fieldName, String(value));
              } catch (fieldError) {
                throw new Error(
                  `Failed to set field "${fieldName}": ${fieldError}`,
                );
              }
            }
          }

          // Set creators
          if (creators && Array.isArray(creators)) {
            item.setCreators(
              creators.map((c: any) => {
                const creatorData: any = {
                  creatorType: c.creatorType || "author",
                };
                if (c.name) {
                  creatorData.name = c.name;
                } else {
                  creatorData.firstName = c.firstName || "";
                  creatorData.lastName = c.lastName || "";
                }
                return creatorData;
              }),
            );
          }

          // Add tags
          if (tags && Array.isArray(tags)) {
            for (const tag of tags) {
              item.addTag(tag, 0);
            }
          }

          const notifierQueue = createNotifierQueue();
          const reparentedAttachments: string[] = [];
          let writeFailed = false;
          let writeError: unknown;

          try {
            // 创建 parent 与全部附件挂接在一个原生事务内完成。
            await Zotero.DB.executeTransaction(async () => {
              const attachments = [];
              const collectionIDs = new Set<number>();
              for (const attKey of attachmentKeys || []) {
                const attachment = await Zotero.Items.getByLibraryAndKeyAsync(
                  libraryID,
                  attKey,
                );
                if (
                  !attachment ||
                  !attachment.isAttachment() ||
                  attachment.parentKey ||
                  attachment.deleted
                ) {
                  throw new PlusError(
                    "STATE_CHANGED",
                    "独立附件已发生变化，整组创建将回滚",
                  );
                }
                attachments.push(attachment);
                for (const id of attachment.getCollections())
                  collectionIDs.add(id);
              }
              item.setCollections([...collectionIDs]);
              await item.save(notifierSaveOptions(notifierQueue));
              for (const attachment of attachments) {
                attachment.setCollections([]);
                attachment.parentKey = item.key;
                await attachment.save(notifierSaveOptions(notifierQueue));
                reparentedAttachments.push(attachment.key);
              }
            });
          } catch (error) {
            writeFailed = true;
            writeError = error;
          }

          if (writeFailed) throw writeError;
          const notification = await commitNotifierQueue(
            notifierQueue,
            `create item ${item.key}`,
          );

          return {
            action: "create",
            success: true,
            data: {
              itemKey: item.key,
              itemType,
              title: fields?.title || "",
              creatorsCount: creators?.length || 0,
              tagsCount: tags?.length || 0,
              reparentedAttachments,
              dateCreated: item.dateAdded,
            },
            metadata: {
              extractedAt: new Date().toISOString(),
              notificationStatus: notification.status,
              message: `Item created (key: ${item.key}, type: ${itemType})${reparentedAttachments.length > 0 ? `, ${reparentedAttachments.length} attachment(s) attached` : ""}`,
            },
          };
        }

        case "reparent": {
          if (
            !attachmentKeys ||
            !Array.isArray(attachmentKeys) ||
            attachmentKeys.length === 0
          ) {
            throw new Error("attachmentKeys is required for reparent action");
          }
          if (!parentKey) {
            throw new Error("parentKey is required for reparent action");
          }

          // Verify parent exists
          const parentItem = await Zotero.Items.getByLibraryAndKeyAsync(
            libraryID,
            parentKey,
          );
          if (!parentItem) {
            throw new Error(
              `Parent item not found in library ${libraryID}: ${parentKey}`,
            );
          }
          if (!parentItem.isRegularItem()) {
            throw new Error(
              `Parent ${parentKey} is not a regular item (type: ${parentItem.itemType})`,
            );
          }

          const results: Array<{
            key: string;
            success: boolean;
            error?: string;
          }> = [];
          const notifierQueue = createNotifierQueue();
          await Zotero.DB.executeTransaction(async () => {
            for (const attKey of attachmentKeys) {
              const attachment = await Zotero.Items.getByLibraryAndKeyAsync(
                libraryID,
                attKey,
              );
              if (
                !attachment ||
                attachment.deleted ||
                (!attachment.isAttachment() && !attachment.isNote())
              ) {
                throw new PlusError(
                  "STATE_CHANGED",
                  "待移动子项已改变，整组移动将回滚",
                );
              }
              for (const id of attachment.getCollections())
                parentItem.addToCollection(id);
              attachment.setCollections([]);
              attachment.parentKey = parentKey;
              await attachment.save(notifierSaveOptions(notifierQueue));
              results.push({ key: attKey, success: true });
            }
            await parentItem.save(notifierSaveOptions(notifierQueue));
          });

          const notification = await commitNotifierQueue(
            notifierQueue,
            `reparent items under ${parentKey}`,
          );
          const successCount = results.filter((r) => r.success).length;

          return {
            action: "reparent",
            success: successCount > 0,
            data: {
              parentKey,
              results,
              successCount,
              totalCount: attachmentKeys.length,
            },
            metadata: {
              extractedAt: new Date().toISOString(),
              notificationStatus: notification.status,
              message: `Re-parented ${successCount}/${attachmentKeys.length} item(s) under ${parentKey}`,
            },
          };
        }

        case "import": {
          if (!filePath || typeof filePath !== "string") {
            throw new Error(
              "filePath is required for import action (absolute path to the file)",
            );
          }
          const importParentKey = parentItemKey || parentKey;
          if (!importParentKey) {
            throw new Error("parentItemKey is required for import action");
          }
          if (!(await IOUtils.exists(filePath))) {
            throw new Error(`File not found: ${filePath}`);
          }

          // Verify parent exists
          const parentItem = await Zotero.Items.getByLibraryAndKeyAsync(
            libraryID,
            importParentKey,
          );
          if (!parentItem) {
            throw new Error(
              `Parent item not found in library ${libraryID}: ${importParentKey}`,
            );
          }
          if (!parentItem.isRegularItem()) {
            throw new Error(
              `Parent ${importParentKey} is not a regular item (type: ${parentItem.itemType}), cannot attach files`,
            );
          }

          // Import file as attachment
          const notifierQueue = createNotifierQueue();
          const attachment = await Zotero.Attachments.importFromFile({
            file: filePath,
            parentItemID: parentItem.id,
            title:
              title || filePath.split(/[\\/]/).pop() || "Imported Attachment",
            saveOptions: notifierSaveOptions(notifierQueue),
          });
          const notification = await commitNotifierQueue(
            notifierQueue,
            `import attachment ${attachment.key}`,
          );

          ztoolkit.log(
            `[StreamableMCP] Imported file as attachment ${attachment.key} under ${importParentKey}`,
          );

          return {
            action: "import",
            success: true,
            data: {
              attachmentKey: attachment.key,
              parentItemKey: importParentKey,
              title: attachment.getField("title"),
            },
            metadata: {
              extractedAt: new Date().toISOString(),
              notificationStatus: notification.status,
              message: `File imported as attachment (key: ${attachment.key}) under parent ${importParentKey}`,
            },
          };
        }

        default:
          throw new Error(
            `Unknown action: ${action}. Use create, reparent, or import.`,
          );
      }
    } catch (error) {
      ztoolkit.log(`[StreamableMCP] Write item error: ${error}`, "error");
      return {
        success: false,
        error: String(error),
      };
    }
  }

  // ---------------------------------------------------------------------
  // add_by_identifier
  // ---------------------------------------------------------------------

  // 此入口仅由持久队列逐项调用；旧 jobID 查询由 Plus runtime 处理。
  private async callAddByIdentifier(args: any): Promise<any> {
    const inputs = args.identifiers;
    if (!Array.isArray(inputs) || inputs.length !== 1) {
      throw new PlusError(
        "INVALID_IDENTIFIER_STEP",
        "执行器一次只处理一个 identifier",
      );
    }
    const libraryID = args.libraryID;
    let collections: number[] | false = false;
    if (args.collectionKey) {
      const collection = await Zotero.Collections.getByLibraryAndKeyAsync(
        libraryID,
        args.collectionKey,
      );
      if (!collection)
        throw new PlusError("COLLECTION_NOT_FOUND", "集合不存在");
      collections = [collection.id];
    }
    const result = await this.importOneIdentifier(inputs[0], {
      libraryID,
      collections,
      saveAttachments: args.saveAttachments !== false,
      skipExisting: args.skipExisting !== false,
      fileExisting: args.fileExisting === true,
      dryRun: false,
      titleDuplicates: args.titleDuplicates || "flag",
      expectedExistingKey: args.expectedExistingKey,
    });
    return { success: result.status !== "error", data: result };
  }

  private async importOneIdentifier(input: string, opts: any): Promise<any> {
    const identifiers = (Zotero.Utilities as any).extractIdentifiers(input);
    if (!identifiers.length) {
      return { input, status: "error", error: "NO_IDENTIFIER_FOUND" };
    }
    if (identifiers.length > 1) {
      // One entry should mean one item; anything else is ambiguous input.
      return {
        input,
        status: "error",
        error: "AMBIGUOUS_INPUT",
        parsed: identifiers.map((id: any) => this.describeIdentifier(id)),
      };
    }

    const identifier = identifiers[0];
    const parsed = this.describeIdentifier(identifier);

    if (opts.dryRun) {
      return { input, status: "parsed", identifier: parsed };
    }

    if (opts.skipExisting) {
      const existing = await this.findItemByIdentifier(
        opts.libraryID,
        identifier,
      );
      if ((existing?.key || null) !== opts.expectedExistingKey) {
        throw new PlusError(
          "STATE_CHANGED",
          "identifier 的现有匹配已改变，必须重新预览",
        );
      }
      if (existing) {
        let addedToCollection = false;
        // The only path in this tool that touches an item already in the
        // library, so it has to be asked for explicitly.
        if (opts.fileExisting && opts.collections) {
          const current = existing.getCollections();
          const missing = opts.collections.filter(
            (cid: number) => !current.includes(cid),
          );
          if (missing.length) {
            for (const cid of missing) {
              existing.addToCollection(cid);
            }
            await existing.saveTx();
            addedToCollection = true;
          }
        }
        return {
          input,
          identifier: parsed,
          status: "exists",
          addedToCollection,
          item: this.summarizeIdentifierItem(existing),
        };
      }
    }

    const translate = new (Zotero as any).Translate.Search();
    translate.setIdentifier(identifier);
    // Be lenient about translators, exactly like lookup.js
    const translators = await translate.getTranslators();
    if (!translators || !translators.length) {
      return {
        input,
        identifier: parsed,
        status: "error",
        error: "NO_TRANSLATOR",
      };
    }
    translate.setTranslator(translators);

    const newItems = await translate.translate({
      libraryID: opts.libraryID,
      collections: opts.collections,
      saveAttachments: opts.saveAttachments,
    });

    if (!newItems || !newItems.length) {
      return {
        input,
        identifier: parsed,
        status: "error",
        error: "NO_ITEM_RETURNED",
      };
    }

    ztoolkit.log("[StreamableMCP] identifier 导入已返回结果");

    // A preprint and its published version share no identifier, so the check
    // above cannot see them as the same work. The title is only known after
    // resolution, hence this second pass.
    let duplicatesOf: any[] = [];
    if (opts.titleDuplicates !== "off") {
      duplicatesOf = await this.findItemsByTitle(opts.libraryID, newItems[0]);
    }

    if (duplicatesOf.length && opts.titleDuplicates === "skip") {
      const imported = newItems[0];
      imported.deleted = true; // to the trash, not erased
      await imported.saveTx();
      return {
        input,
        identifier: parsed,
        status: "duplicate_trashed",
        trashedItemKey: imported.key,
        duplicateOf: duplicatesOf,
        item: this.summarizeIdentifierItem(imported),
      };
    }

    return {
      input,
      identifier: parsed,
      status: "imported",
      item: this.summarizeIdentifierItem(newItems[0]),
      ...(duplicatesOf.length ? { possibleDuplicateOf: duplicatesOf } : {}),
      extraItems: newItems
        .slice(1)
        .map((i: any) => this.summarizeIdentifierItem(i)),
    };
  }

  /**
   * Find other regular items in the library whose title normalizes to the same
   * string. Deliberately exact-after-normalization rather than fuzzy: catching
   * "preprint vs published version" is worth it, guessing is not.
   */
  private async findItemsByTitle(libraryID: number, item: any): Promise<any[]> {
    const normalize = (value: string) =>
      String(value || "")
        .toLowerCase()
        .replace(/[^a-z0-9一-鿿]+/g, " ")
        .trim();

    const title = item.getField("title");
    const target = normalize(title);
    if (target.length < 8) return [];

    // Cheap candidate filter, then compare normalized titles in full: a
    // 'contains' search cannot survive punctuation differences on its own.
    const tokens = target.split(" ").filter((t: string) => t.length >= 5);
    const probe =
      tokens.sort((a: string, b: string) => b.length - a.length)[0] ||
      target.slice(0, 20);

    try {
      const search = new Zotero.Search();
      (search as any).libraryID = libraryID;
      search.addCondition("noChildren", "true");
      search.addCondition("title", "contains", probe);
      const ids = await search.search();
      if (!ids || !ids.length) return [];

      const candidates = await Zotero.Items.getAsync(ids);
      return candidates
        .filter((c: any) => c.id !== item.id && c.isRegularItem() && !c.deleted)
        .filter((c: any) => normalize(c.getField("title")) === target)
        .map((c: any) => this.summarizeIdentifierItem(c));
    } catch (error) {
      ztoolkit.log(
        `[StreamableMCP] add_by_identifier title duplicate check failed: ${error}`,
        "warn",
      );
      return [];
    }
  }

  /**
   * Look for an item already in the library carrying this identifier, so that
   * repeated calls do not pile up duplicates.
   */
  private async findItemByIdentifier(
    libraryID: number,
    identifier: any,
  ): Promise<any> {
    return lookupIdentifier(libraryID, identifier);
  }

  private describeIdentifier(identifier: any): string {
    if (!identifier) return "";
    for (const key of ["DOI", "arXiv", "ISBN", "PMID", "adsBibcode"]) {
      const value = identifier[key];
      if (value)
        return `${key}:${Array.isArray(value) ? value.join(",") : value}`;
    }
    return JSON.stringify(identifier);
  }

  private summarizeIdentifierItem(item: any): any {
    const summary: any = {
      itemKey: item.key,
      itemType: Zotero.ItemTypes.getName(item.itemTypeID),
      title: item.getField("title"),
      date: item.getField("date"),
      DOI: item.getField("DOI") || "",
      url: item.getField("url") || "",
      extra: item.getField("extra") || "",
    };
    for (const field of [
      "publicationTitle",
      "proceedingsTitle",
      "repository",
      "publisher",
    ]) {
      try {
        const value = item.getField(field);
        if (value) {
          summary.venue = value;
          break;
        }
      } catch (error) {
        // Field is not valid for this item type
      }
    }
    return summary;
  }

  /**
   * Format tool result for MCP response with intelligent content type detection
   */
  private formatToolResult(result: any, toolName: string, args: any): any {
    // Check if client explicitly requested text format
    const requestedTextFormat = args?.format === "text";

    // If result is already a string (text format), wrap it in MCP content format
    if (typeof result === "string") {
      return {
        content: [
          {
            type: "text",
            text: result,
          },
        ],
        isError: false,
      };
    }

    // For structured data, provide both JSON and formatted options
    if (typeof result === "object" && result !== null) {
      // If explicitly requested text format, convert to readable text
      if (requestedTextFormat) {
        return {
          content: [
            {
              type: "text",
              text: this.formatObjectAsText(result, toolName),
            },
          ],
          isError: false,
        };
      }

      // Default: provide structured JSON with formatted preview
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
        isError: false,
        // Include raw structured data for programmatic access
        _structuredData: result,
        _contentType: "application/json",
      };
    }

    // Fallback for other types
    return {
      content: [
        {
          type: "text",
          text: String(result),
        },
      ],
      isError: false,
    };
  }

  /**
   * Format object as human-readable text based on tool type
   */
  private formatObjectAsText(obj: any, toolName: string): string {
    switch (toolName) {
      case "get_content":
        return this.formatContentAsText(obj);
      case "search_library":
        return this.formatSearchResultsAsText(obj);
      case "get_annotations":
        return this.formatAnnotationsAsText(obj);
      default:
        return JSON.stringify(obj, null, 2);
    }
  }

  private formatContentAsText(contentResult: any): string {
    const parts = [];

    if (contentResult.title) {
      parts.push(`TITLE: ${contentResult.title}\n`);
    }

    if (contentResult.content) {
      if (contentResult.content.abstract) {
        parts.push(`ABSTRACT:\n${contentResult.content.abstract.content}\n`);
      }

      if (contentResult.content.attachments) {
        for (const att of contentResult.content.attachments) {
          parts.push(
            `ATTACHMENT (${att.filename || att.type}):\n${att.content}\n`,
          );
        }
      }

      if (contentResult.content.notes) {
        for (const note of contentResult.content.notes) {
          parts.push(`NOTE (${note.title}):\n${note.content}\n`);
        }
      }
    }

    return parts.join("\n---\n\n");
  }

  private formatSearchResultsAsText(searchResult: any): string {
    if (!searchResult.results || !Array.isArray(searchResult.results)) {
      return JSON.stringify(searchResult, null, 2);
    }

    const parts = [`SEARCH RESULTS (${searchResult.results.length} items):\n`];

    searchResult.results.forEach((item: any, index: number) => {
      parts.push(`${index + 1}. ${item.title || "Untitled"}`);
      if (item.creators && item.creators.length > 0) {
        parts.push(
          `   Authors: ${item.creators.map((c: any) => c.name || `${c.firstName} ${c.lastName}`).join(", ")}`,
        );
      }
      if (item.date) {
        parts.push(`   Date: ${item.date}`);
      }
      if (item.itemKey) {
        parts.push(`   Key: ${item.itemKey}`);
      }
      parts.push("");
    });

    return parts.join("\n");
  }

  private formatAnnotationsAsText(annotationResult: any): string {
    if (!annotationResult.data || !Array.isArray(annotationResult.data)) {
      return JSON.stringify(annotationResult, null, 2);
    }

    const parts = [`ANNOTATIONS (${annotationResult.data.length} items):\n`];

    annotationResult.data.forEach((ann: any, index: number) => {
      parts.push(`${index + 1}. [${ann.type.toUpperCase()}] ${ann.content}`);
      if (ann.page) {
        parts.push(`   Page: ${ann.page}`);
      }
      if (ann.dateModified) {
        parts.push(`   Modified: ${ann.dateModified}`);
      }
      parts.push("");
    });

    return parts.join("\n");
  }

  private createResponse(id: string | number | null, result: any): MCPResponse {
    return {
      jsonrpc: "2.0",
      id,
      result,
    };
  }

  private createError(
    id: string | number | null,
    code: number,
    message: string,
    data?: any,
  ): MCPResponse {
    return {
      jsonrpc: "2.0",
      id,
      error: { code, message, data },
    };
  }

  private isNotificationRequest(request: MCPRequest): boolean {
    return (
      !Object.prototype.hasOwnProperty.call(request, "id") ||
      request.id === null ||
      request.id === undefined
    );
  }

  /**
   * Get server status and capabilities
   */
  getStatus() {
    return {
      isInitialized: this.isInitialized,
      serverInfo: this.serverInfo,
      protocolVersion: PLUS_PROTOCOL_VERSION,
      supportedMethods: [
        "initialize",
        "initialized",
        "notifications/initialized",
        "tools/list",
        "tools/call",
        "resources/list",
        "prompts/list",
        "ping",
      ],
      availableTools: this.listTools().map((tool) => tool.name),
      transport: {
        type: "streamable-http",
        keepAliveSupported: false,
        stateless: true,
        notificationsSupported: false,
      },
    };
  }

  /**
   * Get fulltext search mode configuration
   */
  private getFulltextModeConfiguration(mode: string): any {
    const modeConfigs = {
      minimal: {
        contextLength: 100,
        maxResults: 20,
      },
      preview: {
        contextLength: 200,
        maxResults: 50,
      },
      standard: {
        contextLength: 250,
        maxResults: 100,
      },
      complete: {
        contextLength: 400,
        maxResults: 200,
      },
    };

    return (
      modeConfigs[mode as keyof typeof modeConfigs] || modeConfigs["standard"]
    );
  }

  /**
   * Get search mode configuration
   */
  private getSearchModeConfiguration(mode: string): any {
    const modeConfigs = {
      minimal: {
        limit: 30,
      },
      preview: {
        limit: 100,
      },
      standard: {
        limit: 200,
      },
      complete: {
        limit: 500,
      },
    };

    return (
      modeConfigs[mode as keyof typeof modeConfigs] || modeConfigs["standard"]
    );
  }

  /**
   * Get collection mode configuration
   */
  private getCollectionModeConfiguration(mode: string): any {
    const modeConfigs = {
      minimal: {
        limit: 20,
      },
      preview: {
        limit: 50,
      },
      standard: {
        limit: 100,
      },
      complete: {
        limit: 500,
      },
    };

    return (
      modeConfigs[mode as keyof typeof modeConfigs] || modeConfigs["standard"]
    );
  }

  /**
   * Get item details mode configuration
   */
  private getItemDetailsModeConfiguration(mode: string): any {
    const modeConfigs = {
      minimal: {
        fields: ["key", "title", "creators", "date", "itemType"],
      },
      preview: {
        fields: [
          "key",
          "title",
          "creators",
          "date",
          "itemType",
          "abstractNote",
          "extra",
          "tags",
          "collections",
        ],
      },
      standard: {
        fields: null, // Include most fields (default behavior)
      },
      complete: {
        fields: null, // Include all fields
      },
    };

    return (
      modeConfigs[mode as keyof typeof modeConfigs] || modeConfigs["standard"]
    );
  }
}
