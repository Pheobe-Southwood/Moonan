import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.js";
import "./styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("#root is missing from index.html");

// The shell mounts the Chord `ConnectionProvider` itself, and only once the account gate has
// a session: the platform refuses a WebSocket that is not authenticated.
createRoot(container).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
