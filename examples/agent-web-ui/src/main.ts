import { createApp } from "vue";
import "./style.css";
import YouTrackStatus from "./YouTrackStatus.vue";
import MonitorApp from "./MonitorApp.vue";

createApp(location.pathname.startsWith('/console/youtrack') ? YouTrackStatus : MonitorApp).mount("#app");
