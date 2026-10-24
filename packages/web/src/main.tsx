import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.js";
import { ConnectionProvider } from "./chord/connection.js";
import "./styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("#root is missing from index.html");

createRoot(container).render(
	<StrictMode>
		<ConnectionProvider>
			<App />
		</ConnectionProvider>
	</StrictMode>,
);
