import { mount } from "svelte"
import App from "./App.svelte"
import { app } from "./lib/app.svelte.ts"
import "./app.css"

mount(App, { target: document.getElementById("app")! })
void app.start()

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  void navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {})
}
