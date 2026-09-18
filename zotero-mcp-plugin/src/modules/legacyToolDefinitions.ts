import type { ToolDefinition } from "./toolRegistry.ts";

// 保留上游工具 schema；实际安全参数由注册表统一补充。
export const LEGACY_TOOLS: ToolDefinition[] = [
  {
    name: "get_libraries",
    description:
      "List all Zotero libraries available in the current client. Returns minimal library metadata for each library as a paginated array.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Maximum results to return" },
        offset: { type: "number", description: "Pagination offset" },
      },
    },
  },
  {
    name: "search_library",
    description:
      'Search the Zotero library with advanced parameters, boolean operators, relevance scoring, and pagination. Results are from user\'s personal library. Use itemKey with get_content for full text. To find standalone PDFs without metadata, use itemType="attachment" with includeAttachments="true".',
    inputSchema: {
      type: "object",
      properties: {
        libraryID: {
          type: "number",
          description:
            "Optional target Zotero library ID. Defaults to the user library when omitted.",
        },
        q: { type: "string", description: "General search query" },
        collectionKey: {
          type: "string",
          description: "Filter standalone attachments by collection key",
        },
        tag: {
          type: "string",
          description: "Filter standalone attachments by tag",
        },
        title: { type: "string", description: "Title search" },
        titleOperator: {
          type: "string",
          enum: ["contains", "exact", "startsWith", "endsWith", "regex"],
          description: "Title search operator",
        },
        yearRange: {
          type: "string",
          description: 'Year range (e.g., "2020-2023")',
        },
        fulltext: {
          type: "string",
          description: "Full-text search in attachments and notes",
        },
        fulltextMode: {
          type: "string",
          enum: ["attachment", "note", "both"],
          description:
            "Full-text search mode: attachment (PDFs only), note (notes only), both (default)",
        },
        fulltextOperator: {
          type: "string",
          enum: ["contains", "exact", "regex"],
          description: "Full-text search operator (default: contains)",
        },
        itemType: {
          type: "string",
          description:
            'Filter by item type (e.g., "attachment" to list standalone files like PDFs imported without metadata, "journalArticle", "book", etc.)',
        },
        includeAttachments: {
          type: "string",
          enum: ["true", "false"],
          description:
            'Include standalone attachments. With itemType="attachment", omitted means included for legacy compatibility; explicit "false" excludes them. Other searches default to false.',
        },
        mode: {
          type: "string",
          enum: ["minimal", "preview", "standard", "complete"],
          description:
            "Processing mode: minimal (30 results), preview (100), standard (adaptive), complete (500+). Uses user default if not specified.",
        },
        relevanceScoring: {
          type: "boolean",
          description: "Enable relevance scoring",
        },
        sort: {
          type: "string",
          enum: ["relevance", "date", "title", "year"],
          description: "Sort order",
        },
        limit: {
          type: "number",
          description: "Maximum results to return (overrides mode default)",
        },
        offset: { type: "number", description: "Pagination offset" },
      },
    },
  },
  {
    name: "search_libraries",
    description: "Search libraries by name",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "Library name search query" },
        limit: { type: "number", description: "Maximum results to return" },
        offset: { type: "number", description: "Pagination offset" },
      },
      required: ["q"],
    },
  },
  {
    name: "search_annotations",
    description:
      "Search and filter annotations (highlights, notes, comments) by query, colors, or tags. Returns user's personal research notes with relevance scoring. Preserve exact wording when quoting.",
    inputSchema: {
      type: "object",
      properties: {
        libraryID: {
          type: "number",
          description:
            "Optional target Zotero library ID. Defaults to the user library when omitted.",
        },
        q: {
          type: "string",
          description: "Search query (optional if colors or tags provided)",
        },
        itemKeys: {
          type: "array",
          items: { type: "string" },
          description: "Limit search to specific items",
        },
        types: {
          type: "array",
          items: {
            type: "string",
            enum: ["note", "highlight", "annotation", "ink", "text", "image"],
          },
          description: "Types of annotations to search",
        },
        colors: {
          type: "array",
          items: { type: "string" },
          description:
            "Filter by colors. Use hex codes (#ffd400) or names (yellow, red, green, blue, purple, orange). Common mappings: yellow=question, red=error/important, green=agree, blue=info, purple=definition",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Filter by tags attached to annotations",
        },
        mode: {
          type: "string",
          enum: ["standard", "preview", "complete", "minimal"],
          description:
            "Content processing mode (uses user setting default if not specified)",
        },
        maxTokens: {
          type: "number",
          description:
            "Token budget (uses user setting default if not specified)",
        },
        minRelevance: {
          type: "number",
          minimum: 0,
          maximum: 1,
          default: 0.1,
          description:
            "Minimum relevance threshold (only applies when q is provided)",
        },
        limit: { type: "number", default: 15, description: "Maximum results" },
        offset: {
          type: "number",
          default: 0,
          description: "Pagination offset",
        },
      },
      description: "Requires at least one of: q (query), colors, or tags",
    },
  },
  {
    name: "get_item_details",
    description:
      "Get detailed bibliographic metadata for a specific item (title, authors, dates, identifiers, attachments, notes, tags). Use get_content for full text. Suitable for generating citations and references.",
    inputSchema: {
      type: "object",
      properties: {
        libraryID: {
          type: "number",
          description:
            "Optional target Zotero library ID. Defaults to the user library when omitted.",
        },
        itemKey: { type: "string", description: "Unique item key" },
        mode: {
          type: "string",
          enum: ["minimal", "preview", "standard", "complete"],
          description:
            "Processing mode: minimal (basic info), preview (key fields), standard (comprehensive), complete (all fields). Uses user default if not specified.",
        },
      },
      required: ["itemKey"],
    },
  },
  {
    name: "get_annotations",
    description:
      "Get annotations and notes for specific items with color/tag filtering. REQUIRED: provide one of itemKey, annotationId, or annotationIds (use search_library first to find the itemKey; use search_annotations to search by colors/tags across the library). Returns user's personal highlights and comments from PDFs. Preserve exact wording when quoting.",
    inputSchema: {
      type: "object",
      properties: {
        libraryID: {
          type: "number",
          description:
            "Optional target Zotero library ID. Defaults to the user library when omitted.",
        },
        itemKey: {
          type: "string",
          description: "Get all annotations for this item",
        },
        annotationId: {
          type: "string",
          description: "Get specific annotation by ID",
        },
        annotationIds: {
          type: "array",
          items: { type: "string" },
          description: "Get multiple annotations by IDs",
        },
        types: {
          type: "array",
          items: {
            type: "string",
            enum: ["note", "highlight", "annotation", "ink", "text", "image"],
          },
          default: ["note", "highlight", "annotation"],
          description: "Types of annotations to include",
        },
        colors: {
          type: "array",
          items: { type: "string" },
          description:
            'Filter by colors. Use hex codes (#ffd400) or names (yellow, red, green, blue, purple, orange). Example: ["yellow", "red"] to get question and error annotations',
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Filter by tags attached to annotations",
        },
        mode: {
          type: "string",
          enum: ["standard", "preview", "complete", "minimal"],
          description:
            "Content processing mode (uses user setting default if not specified)",
        },
        maxTokens: {
          type: "number",
          description:
            "Token budget (uses user setting default if not specified)",
        },
        limit: { type: "number", default: 20, description: "Maximum results" },
        offset: {
          type: "number",
          default: 0,
          description: "Pagination offset",
        },
      },
      description:
        "Requires either itemKey, annotationId, or annotationIds parameter",
    },
  },
  {
    name: "get_content",
    description:
      "Get full-text content from PDFs, attachments, notes, and abstracts. May contain OCR artifacts. When user asks for complete text, provide it without summarization.",
    inputSchema: {
      type: "object",
      properties: {
        libraryID: {
          type: "number",
          description:
            "Optional target Zotero library ID. Defaults to the user library when omitted.",
        },
        itemKey: {
          type: "string",
          description: "Item key to get all content from this item",
        },
        attachmentKey: {
          type: "string",
          description: "Attachment key to get content from specific attachment",
        },
        mode: {
          type: "string",
          enum: ["minimal", "preview", "standard", "complete"],
          description:
            "Content processing mode: minimal (500 chars, fastest), preview (1.5K chars, quick scan), standard (3K chars, balanced), complete (unlimited, complete content). Uses user default if not specified.",
        },
        include: {
          type: "object",
          properties: {
            pdf: {
              type: "boolean",
              default: true,
              description: "Include PDF attachments content",
            },
            attachments: {
              type: "boolean",
              default: true,
              description: "Include other attachments content",
            },
            notes: {
              type: "boolean",
              default: true,
              description: "Include notes content",
            },
            abstract: {
              type: "boolean",
              default: true,
              description: "Include abstract",
            },
            webpage: {
              type: "boolean",
              default: false,
              description:
                "Include webpage snapshots (auto-enabled in standard/complete modes)",
            },
          },
          description: "Content types to include (only applies to itemKey)",
        },
        contentControl: {
          type: "object",
          properties: {
            preserveOriginal: {
              type: "boolean",
              default: true,
              description:
                "Always preserve original text structure when processing",
            },
            allowExtended: {
              type: "boolean",
              default: false,
              description:
                "Allow retrieving more content than mode default when important",
            },
            expandIfImportant: {
              type: "boolean",
              default: false,
              description: "Expand content length for high-importance content",
            },
            maxContentLength: {
              type: "number",
              description: "Override maximum content length for this request",
            },
            prioritizeCompleteness: {
              type: "boolean",
              default: false,
              description:
                "Prioritize complete sentences/paragraphs over strict length limits",
            },
            standardExpansion: {
              type: "object",
              properties: {
                enabled: {
                  type: "boolean",
                  default: false,
                  description: "Enable standard content expansion",
                },
                trigger: {
                  type: "string",
                  enum: ["high_importance", "user_query", "context_needed"],
                  default: "high_importance",
                  description: "Trigger condition for standard expansion",
                },
                maxExpansionRatio: {
                  type: "number",
                  default: 2.0,
                  minimum: 1.0,
                  maximum: 10.0,
                  description:
                    "Maximum expansion ratio (1.0 = no expansion, 2.0 = double)",
                },
              },
              description: "Smart expansion configuration",
            },
          },
          description:
            "Advanced content control parameters to override mode defaults",
        },
        format: {
          type: "string",
          enum: ["json", "text"],
          default: "json",
          description:
            "Output format: json (structured with metadata) or text (plain text)",
        },
      },
      description: "Requires either itemKey or attachmentKey parameter",
    },
  },
  {
    name: "get_collections",
    description:
      "Get collections in the library. By default returns a flat, paginated list of top-level collections. Use recursive=true to retrieve the complete nested collection tree (all levels) in one call. Use parentCollection to scope to a specific parent's direct children.",
    inputSchema: {
      type: "object",
      properties: {
        libraryID: {
          type: "number",
          description:
            "Optional target Zotero library ID. Defaults to the user library when omitted.",
        },
        mode: {
          type: "string",
          enum: ["minimal", "preview", "standard", "complete"],
          description:
            "Processing mode: minimal (20 collections), preview (50), standard (100), complete (500+). Uses user default if not specified. Ignored when recursive=true.",
        },
        limit: {
          type: "number",
          description:
            "Maximum results to return (overrides mode default). Ignored when recursive=true.",
        },
        offset: {
          type: "number",
          description: "Pagination offset. Ignored when recursive=true.",
        },
        recursive: {
          type: "boolean",
          description:
            "When true, recursively return the full nested collection tree. Each collection includes a subcollections array of its children. Pagination is ignored.",
        },
        parentCollection: {
          type: "string",
          description:
            "Key of a parent collection. When provided, returns direct children of that collection instead of top-level collections.",
        },
      },
    },
  },
  {
    name: "search_collections",
    description: "Search collections by name",
    inputSchema: {
      type: "object",
      properties: {
        libraryID: {
          type: "number",
          description:
            "Optional target Zotero library ID. Defaults to the user library when omitted.",
        },
        q: { type: "string", description: "Collection name search query" },
        limit: { type: "number", description: "Maximum results to return" },
      },
    },
  },
  {
    name: "get_collection_details",
    description: "Get detailed information about a specific collection",
    inputSchema: {
      type: "object",
      properties: {
        collectionKey: { type: "string", description: "Collection key" },
        libraryID: {
          type: "number",
          description:
            "Optional target Zotero library ID. Defaults to the user library when omitted.",
        },
      },
      required: ["collectionKey"],
    },
  },
  {
    name: "get_collection_items",
    description: "Get items in a specific collection",
    inputSchema: {
      type: "object",
      properties: {
        collectionKey: { type: "string", description: "Collection key" },
        libraryID: {
          type: "number",
          description:
            "Optional target Zotero library ID. Defaults to the user library when omitted.",
        },
        limit: { type: "number", description: "Maximum results to return" },
        offset: { type: "number", description: "Pagination offset" },
      },
      required: ["collectionKey"],
    },
  },
  {
    name: "get_subcollections",
    description:
      "Get subcollections (child collections) of a specific collection. Use recursive=true to retrieve the full nested hierarchy of all descendant collections.",
    inputSchema: {
      type: "object",
      properties: {
        collectionKey: { type: "string", description: "Parent collection key" },
        libraryID: {
          type: "number",
          description:
            "Optional target Zotero library ID. Defaults to the user library when omitted.",
        },
        limit: {
          type: "number",
          description:
            "Maximum results to return (default: 100). Ignored when recursive=true.",
        },
        offset: {
          type: "number",
          description:
            "Pagination offset (default: 0). Ignored when recursive=true.",
        },
        recursive: {
          type: "boolean",
          description:
            "When true, recursively return all descendant subcollections as a nested tree (default: false).",
        },
      },
      required: ["collectionKey"],
    },
  },
  {
    name: "create_collection",
    description:
      "Create a new collection in the library. Optionally nest it under a parent collection.",
    inputSchema: {
      type: "object",
      properties: {
        libraryID: {
          type: "number",
          description:
            "Optional target Zotero library ID. Defaults to the user library when omitted.",
        },
        name: { type: "string", description: "Name of the new collection" },
        parentCollection: {
          type: "string",
          description:
            "Key of the parent collection. If omitted, creates a top-level collection.",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "update_collection",
    description:
      "Rename or move an existing collection. Provide name to rename, parentCollection to move (empty string moves to top level).",
    inputSchema: {
      type: "object",
      properties: {
        libraryID: {
          type: "number",
          description:
            "Optional target Zotero library ID. Defaults to the user library when omitted.",
        },
        collectionKey: {
          type: "string",
          description: "Key of the collection to update",
        },
        name: { type: "string", description: "New name for the collection" },
        parentCollection: {
          type: "string",
          description:
            'Key of the new parent collection. Use empty string "" to move to top level.',
        },
      },
      required: ["collectionKey"],
    },
  },
  {
    name: "delete_collection",
    description:
      "Delete a collection. WARNING: This is a destructive operation. By default, items in the collection are NOT deleted (only removed from the collection). Set deleteItems=true to also send items to trash.",
    inputSchema: {
      type: "object",
      properties: {
        libraryID: {
          type: "number",
          description:
            "Optional target Zotero library ID. Defaults to the user library when omitted.",
        },
        collectionKey: {
          type: "string",
          description: "Key of the collection to delete",
        },
        deleteItems: {
          type: "boolean",
          description:
            "If true, also send items in the collection to trash. Default: false (items remain in library).",
        },
      },
      required: ["collectionKey"],
    },
  },
  {
    name: "add_items_to_collection",
    description: "Add one or more items to a collection by their item keys.",
    inputSchema: {
      type: "object",
      properties: {
        libraryID: {
          type: "number",
          description:
            "Optional target Zotero library ID. Defaults to the user library when omitted.",
        },
        collectionKey: {
          type: "string",
          description: "Key of the target collection",
        },
        itemKeys: {
          type: "array",
          items: { type: "string" },
          description: "Array of item keys to add to the collection",
        },
      },
      required: ["collectionKey", "itemKeys"],
    },
  },
  {
    name: "remove_items_from_collection",
    description:
      "Remove one or more items from a collection. Items are NOT deleted from the library, only removed from this collection.",
    inputSchema: {
      type: "object",
      properties: {
        libraryID: {
          type: "number",
          description:
            "Optional target Zotero library ID. Defaults to the user library when omitted.",
        },
        collectionKey: { type: "string", description: "Key of the collection" },
        itemKeys: {
          type: "array",
          items: { type: "string" },
          description: "Array of item keys to remove from the collection",
        },
      },
      required: ["collectionKey", "itemKeys"],
    },
  },
  {
    name: "search_fulltext",
    description:
      "Search within full-text content of all documents. Returns matching passages with context. Use get_content with itemKey for complete text of a result.",
    inputSchema: {
      type: "object",
      properties: {
        libraryID: {
          type: "number",
          description:
            "Optional target Zotero library ID. Defaults to the user library when omitted.",
        },
        q: { type: "string", description: "Search query" },
        itemKeys: {
          type: "array",
          items: { type: "string" },
          description: "Limit search to specific items (optional)",
        },
        mode: {
          type: "string",
          enum: ["minimal", "preview", "standard", "complete"],
          description:
            "Processing mode: minimal (100 context), preview (200), standard (adaptive), complete (400+). Uses user default if not specified.",
        },
        contextLength: {
          type: "number",
          description: "Context length around matches (overrides mode default)",
        },
        maxResults: {
          type: "number",
          description: "Maximum results to return (overrides mode default)",
        },
        caseSensitive: {
          type: "boolean",
          description: "Case sensitive search (default: false)",
        },
      },
      required: ["q"],
    },
  },
  {
    name: "get_item_abstract",
    description:
      "Get the abstract/summary of a specific item. Typically the author's own summary from the original publication.",
    inputSchema: {
      type: "object",
      properties: {
        libraryID: {
          type: "number",
          description:
            "Optional target Zotero library ID. Defaults to the user library when omitted.",
        },
        itemKey: { type: "string", description: "Item key" },
        format: {
          type: "string",
          enum: ["json", "text"],
          description: "Response format (default: json)",
        },
      },
      required: ["itemKey"],
    },
  },
  // Semantic Search Tools
  {
    name: "semantic_search",
    description:
      "AI-powered semantic search using embeddings. Finds conceptually related content even without exact keyword matches. Combine with keyword search (search_library, search_fulltext) for comprehensive results.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            'Natural language search query (e.g., "machine learning in healthcare")',
        },
        topK: {
          type: "number",
          description: "Number of results to return (default: 10)",
        },
        minScore: {
          type: "number",
          description: "Minimum similarity score 0-1 (default: 0.3)",
        },
        language: {
          type: "string",
          enum: ["zh", "en", "all"],
          description: "Filter by language (default: all)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "find_similar",
    description:
      "Find items semantically similar to a given item using AI embeddings. Useful for expanding research from a known relevant paper and discovering thematic clusters.",
    inputSchema: {
      type: "object",
      properties: {
        itemKey: {
          type: "string",
          description: "The item key to find similar items for",
        },
        topK: {
          type: "number",
          description: "Number of similar items to return (default: 5)",
        },
        minScore: {
          type: "number",
          description: "Minimum similarity score 0-1 (default: 0.5)",
        },
      },
      required: ["itemKey"],
    },
  },
  {
    name: "semantic_status",
    description:
      "Get the status of the semantic search service including index statistics.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  // Full-text Database Tool (read-only operations)
  {
    name: "fulltext_database",
    description:
      "Access the cached full-text content database (read-only). Faster than re-extracting from Zotero. Actions: list (cached items), search (find text), get (retrieve content), stats (database info).",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "search", "get", "stats"],
          description:
            "Action: list (show cached items), search (search within content), get (get full content), stats (database statistics)",
        },
        query: {
          type: "string",
          description: "Search query (required for search action)",
        },
        itemKeys: {
          type: "array",
          items: { type: "string" },
          description: "Item keys for get action",
        },
        limit: {
          type: "number",
          description:
            "Maximum results to return (default: 20 for list/search)",
        },
        caseSensitive: {
          type: "boolean",
          description: "Case sensitive search (default: false)",
        },
      },
      required: ["action"],
    },
  },
  // Write Tools
  {
    name: "write_note",
    description:
      "Create or modify Zotero notes. Supports child notes (attached to items), standalone notes, updating, or appending. Markdown is auto-converted to HTML. Confirm with user before writing.",
    inputSchema: {
      type: "object",
      properties: {
        libraryID: {
          type: "number",
          description:
            "Optional target Zotero library ID. Defaults to the user library when omitted.",
        },
        action: {
          type: "string",
          enum: ["create", "update", "append"],
          description:
            "create: new note, update: replace content, append: add to end",
        },
        parentKey: {
          type: "string",
          description:
            "Item key to attach note to (create action only, omit for standalone note)",
        },
        noteKey: {
          type: "string",
          description: "Existing note key (required for update/append actions)",
        },
        content: {
          type: "string",
          description:
            "Note content in HTML or Markdown format. Markdown is auto-converted to HTML for Zotero storage.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Tags to add to the note",
        },
      },
      required: ["action", "content"],
    },
  },
  {
    name: "write_tag",
    description:
      "Add, remove, or replace tags on Zotero items. Works on any item type. Response includes before/after tag lists for verification. Confirm with user before executing.",
    inputSchema: {
      type: "object",
      properties: {
        libraryID: {
          type: "number",
          description:
            "Optional target Zotero library ID. Defaults to the user library when omitted.",
        },
        action: {
          type: "string",
          enum: ["add", "remove", "set"],
          description:
            "add: add tags (keep existing), remove: remove specific tags, set: replace all tags with provided list",
        },
        itemKey: {
          type: "string",
          description: "Item key to modify tags on",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Tags to add/remove/set",
        },
      },
      required: ["action", "itemKey", "tags"],
    },
  },
  {
    name: "write_metadata",
    description:
      "Update metadata fields on Zotero items (title, abstract, date, URL, DOI, creators, etc.). Only works on regular items, not notes or attachments. Confirm with user before executing.",
    inputSchema: {
      type: "object",
      properties: {
        libraryID: {
          type: "number",
          description:
            "Optional target Zotero library ID. Defaults to the user library when omitted.",
        },
        itemKey: {
          type: "string",
          description: "Item key to update metadata on",
        },
        fields: {
          type: "object",
          description:
            "Fields to update. Common fields: title, abstractNote, date, url, DOI, language, shortTitle, volume, issue, pages, publisher, place, ISBN, ISSN, extra, rights, series, seriesNumber, edition, numPages, journalAbbreviation, publicationTitle, bookTitle",
          additionalProperties: { type: "string" },
        },
        creators: {
          type: "array",
          description:
            "Set the creators list (replaces all existing creators). Each creator has creatorType (author/editor/translator/etc.), and either firstName+lastName or name (for organizations).",
          items: {
            type: "object",
            properties: {
              creatorType: {
                type: "string",
                description:
                  "Creator type: author, editor, translator, contributor, bookAuthor, seriesEditor, reviewedAuthor, etc.",
              },
              firstName: {
                type: "string",
                description: "First name (for individuals)",
              },
              lastName: {
                type: "string",
                description: "Last name (for individuals)",
              },
              name: {
                type: "string",
                description:
                  "Full name (for organizations, use instead of firstName/lastName)",
              },
            },
            required: ["creatorType"],
          },
        },
      },
      required: ["itemKey"],
    },
  },
  {
    name: "write_item",
    description:
      "Create a new Zotero item, re-parent existing attachments, or import a local file as an attachment. Common workflows: (1) read PDF → extract metadata → create item → attach PDF via attachmentKeys; (2) convert PDF to Markdown → import the .md file as attachment via import action. Confirm with user before executing.",
    inputSchema: {
      type: "object",
      properties: {
        libraryID: {
          type: "number",
          description:
            "Optional target Zotero library ID. Defaults to the user library when omitted.",
        },
        action: {
          type: "string",
          enum: ["create", "reparent", "import"],
          description:
            "create: create a new item with metadata. reparent: move an attachment under a different parent item. import: import a local file (e.g., Markdown, PDF) as an attachment to an existing item.",
        },
        itemType: {
          type: "string",
          description:
            "Item type for create action (e.g., journalArticle, book, conferencePaper, thesis, report, webpage, preprint, bookSection, etc.)",
        },
        fields: {
          type: "object",
          description:
            "Metadata fields for create action. Common: title, abstractNote, date, url, DOI, language, volume, issue, pages, publisher, place, publicationTitle, bookTitle, etc.",
          additionalProperties: { type: "string" },
        },
        creators: {
          type: "array",
          description:
            "Creators for create action. Each: {creatorType, firstName, lastName} or {creatorType, name} for organizations.",
          items: {
            type: "object",
            properties: {
              creatorType: {
                type: "string",
                description: "author, editor, translator, contributor, etc.",
              },
              firstName: { type: "string" },
              lastName: { type: "string" },
              name: { type: "string", description: "For organizations" },
            },
            required: ["creatorType"],
          },
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Tags to add to the new item",
        },
        attachmentKeys: {
          type: "array",
          items: { type: "string" },
          description:
            "For create: existing standalone attachment keys to re-parent under the new item. For reparent: attachment keys to move.",
        },
        parentKey: {
          type: "string",
          description:
            "For reparent action: the target parent item key to move attachments to",
        },
        filePath: {
          type: "string",
          description:
            "For import action: absolute path to the file to import as an attachment",
        },
        parentItemKey: {
          type: "string",
          description:
            "For import action: Zotero item key of the parent to attach the file to",
        },
        title: {
          type: "string",
          description:
            "For import action: display title for the attachment (defaults to the file name)",
        },
      },
      required: ["action"],
    },
  },
  {
    name: "add_by_identifier",
    description:
      "Add items to Zotero by identifier (DOI, arXiv ID, ISBN, PMID, or ADS bibcode) using Zotero's own metadata resolvers — the same pipeline as the 'Add Item by Identifier' magic-wand button. Item type, DOI, venue, authors and date all come from Zotero's translators, so prefer this over write_item whenever an identifier is available: write_item requires guessing metadata by hand, which produces wrong item types. Plus defaults to a local dry-run. Confirmed writes always return a persistent taskID/jobID, including single-item imports; poll with task_status or jobID. The legacy async flag is accepted but does not disable the persistent queue.",
    inputSchema: {
      type: "object",
      properties: {
        identifiers: {
          type: "array",
          items: { type: "string" },
          description:
            "One identifier per entry, e.g. '10.1109/ICRA48891.2023.10160731', 'arXiv:2304.00464', '9780262035613', 'PMID: 31452104'. Prefix bare arXiv numbers with 'arXiv:'. Each entry is parsed on its own, so identifier types can be mixed freely.",
        },
        collectionKey: {
          type: "string",
          description:
            "8-character key of the collection to file new items into. Omit to save to the library root.",
        },
        libraryID: {
          type: "number",
          description:
            "Optional target Zotero library ID. Defaults to the user library when omitted.",
        },
        saveAttachments: {
          type: "boolean",
          description:
            "Fetch open-access PDFs along with the metadata (default true).",
        },
        skipExisting: {
          type: "boolean",
          description:
            "Skip identifiers already present in the library instead of creating duplicates (default true).",
        },
        fileExisting: {
          type: "boolean",
          description:
            "When an item already exists, also add it to the target collection. This is the only way this tool modifies existing items (default false).",
        },
        titleDuplicates: {
          type: "string",
          enum: ["flag", "skip", "off"],
          description:
            "How to handle an imported item whose title matches an item already in the library — this catches a preprint arriving next to its published version, which identifier matching cannot see. 'flag' (default) keeps the import and reports possibleDuplicateOf; 'skip' moves the freshly imported item to the trash and reports duplicate_trashed; 'off' disables the check.",
        },
        dryRun: {
          type: "boolean",
          description:
            "Only report how Zotero parses each identifier; writes nothing (default false).",
        },
        delayMs: {
          type: "number",
          description:
            "Pause between lookups in milliseconds, to be polite to upstream APIs (default 500).",
        },
        async: {
          type: "boolean",
          description: "Force background-job mode even for small batches.",
        },
        jobID: {
          type: "string",
          description:
            "Poll a previously started background job instead of starting a new import.",
        },
      },
    },
  },
];
