/**
 * md-image —— 原生自定义元素（Web Component）。
 *
 * markdown 编译期把 <img> 输出为 <md-image data-src=... data-alt=...>，
 * 浏览器解析 {@html} 时自动实例化，零框架运行时：
 * - loading="lazy"：视口外不发起请求（内核级懒加载）；
 * - decoding="async"：解码不阻塞主线程；
 * - data-status：loading / loaded / error 三态驱动 CSS（错误态含 403 访问受限）。
 */

class MdImage extends HTMLElement {
  static observedAttributes = ["data-src"];

  private _img: HTMLImageElement | null = null;

  connectedCallback(): void {
    if (this._img) return; // VList 回收再挂载时避免重复渲染
    const src = this.getAttribute("data-src") ?? "";
    if (!src) return;

    const img = document.createElement("img");
    img.src = src;
    img.alt = this.getAttribute("data-alt") ?? "";
    img.loading = "lazy";
    img.decoding = "async";
    img.className = "md-img";

    img.addEventListener("load", () => this.setAttribute("data-status", "loaded"), { once: true });
    img.addEventListener("error", () => {
      this.setAttribute("data-status", "error");
      // HTTP 错误体为 JSON（ImgProxy 403 等），提取原因供 CSS/无障碍展示
      if (img.src.includes("/__imgproxy/")) {
        this.setAttribute("data-error", "restricted");
      }
    });

    this._img = img;
    this.appendChild(img);
    this.setAttribute("data-status", "loading");
  }

  attributeChangedCallback(name: string, oldV: string | null, newV: string | null): void {
    if (name === "data-src" && oldV !== newV && newV && this._img) {
      this._img.src = newV;
      this.setAttribute("data-status", "loading");
    }
  }
}

if (typeof window !== "undefined" && !customElements.get("md-image")) {
  customElements.define("md-image", MdImage);
}
