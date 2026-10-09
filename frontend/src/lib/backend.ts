/**
 * 后端交互接口（占位实现）。
 *
 * 真实后端接入时，只需把这里的函数替换为 fetch/IPC 调用，
 * UI 层仅依赖 `EditorBackend` 接口，不感知具体实现。
 */

export interface SaveResult {
  ok: boolean;
  /** 提示信息（例如 "stub-local" 表示暂存到本地） */
  message?: string;
}

export interface DocumentMeta {
  id: string;
  title: string;
  updatedAt: number;
}

export interface EditorBackend {
  /** 拉取当前文档（null 表示没有已保存文档，使用内置示例） */
  loadDocument(): Promise<string | null>;

  /** 保存 Markdown 源码（永远保存源码，而非 AST/HTML） */
  saveDocument(markdown: string): Promise<SaveResult>;

  /** 文档列表（为多文档管理预留） */
  listDocuments(): Promise<DocumentMeta[]>;

  /** 导出（预留：pdf / html / ...） */
  exportDocument(markdown: string, format: string): Promise<{ ok: boolean }>;
}

export const stubBackend: EditorBackend = {
  async loadDocument(): Promise<string | null> {
    // TODO(backend): GET /api/document
    return localStorage.getItem("md.draft");
  },

  async saveDocument(markdown: string): Promise<SaveResult> {
    // TODO(backend): PUT /api/document  body: { markdown }
    try {
      localStorage.setItem("md.draft", markdown);
      return { ok: true, message: "stub-local" };
    } catch {
      return { ok: false, message: "quota-exceeded" };
    }
  },

  async listDocuments(): Promise<DocumentMeta[]> {
    // TODO(backend): GET /api/documents
    return [];
  },

  async exportDocument(): Promise<{ ok: boolean }> {
    // TODO(backend): POST /api/export
    return { ok: false };
  },
};
