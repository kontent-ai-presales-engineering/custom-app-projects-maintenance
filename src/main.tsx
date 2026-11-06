import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { AppContextProvider } from "./contexts/AppContext.tsx";
import "./index.css";

const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error("Root element not found");
}

createRoot(rootElement).render(
  <StrictMode>
    <AppContextProvider>
      <App />
    </AppContextProvider>
  </StrictMode>,
);
