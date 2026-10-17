import { mount } from "svelte";
import "./app.css";
import "./themes.css";
import App from "./App.svelte";

const target = document.getElementById("app");
if (!target) throw new Error("#app not found");

mount(App, { target });