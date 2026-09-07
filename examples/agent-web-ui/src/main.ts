import { createApp } from "vue";
import "./style.css";
import App from "./App.vue";
import MonitorApp from "./MonitorApp.vue";

createApp(location.pathname.startsWith('/console/youtrack') ? App : MonitorApp).mount("#app");
