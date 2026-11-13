import { mount } from "svelte";
import "./app.css";
import "./themes.css";
import { installGlobalContextMenuDispatcher } from "./lib/contextmenuRegistry";
import App from "./App.svelte";

const target = document.getElementById("app");
if (!target) throw new Error("#app not found");

/* 全局右键菜单分发器：文档根唯一 capture 监听，替代各持有组件的
 * 自行监听（未注册目标一律阻止默认行为，不弹任何菜单） */
installGlobalContextMenuDispatcher();

mount(App, { target });