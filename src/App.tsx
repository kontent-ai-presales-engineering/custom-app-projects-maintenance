import { setPopupSize } from "@kontent-ai/custom-app-sdk";
import { useState } from "react";
import { useAppConfig, useAppContext } from "./contexts/AppContext.tsx";
import "./App.css";

const App = () => {
  const context = useAppContext();
  const appConfig = useAppConfig();
  const [popupSizeStatus, setPopupSizeStatus] = useState<string>("");
  const [width, setWidth] = useState<number>(800);
  const [height, setHeight] = useState<number>(600);

  const handleResizePopup = async () => {
    const response = await setPopupSize(
      { unit: "px", value: width },
      { unit: "px", value: height },
    );

    if (response.isError) {
      setPopupSizeStatus(`Error: ${response.code} - ${response.description}`);
    } else {
      setPopupSizeStatus(`Popup resized to ${width}x${height} pixels`);
    }

    setTimeout(() => setPopupSizeStatus(""), 3000);
  };

  return (
    <div className="container">
      <h1>Kontent.ai Custom App Starter</h1>

      <section className="section">
        <h2>Observed Context (Live Updates)</h2>
        <p className="description">
          This context is automatically updated when changes occur using the{" "}
          <code>observeCustomAppContext</code> hook.
        </p>
        <pre className="json-display">{JSON.stringify(context, null, 2)}</pre>
      </section>

      <section className="section">
        <h2>Adjust Popup Size</h2>
        <p className="description">
          Resize the custom app popup using <code>setPopupSize</code>.
        </p>
        <div style={{ display: "flex", gap: "1rem", alignItems: "center", marginBottom: "1rem" }}>
          <label>
            Width (px):
            <input
              type="number"
              value={width}
              onChange={(e) => setWidth(Number(e.target.value))}
              min="100"
              style={{ marginLeft: "0.5rem", padding: "0.5rem", width: "100px" }}
            />
          </label>
          <label>
            Height (px):
            <input
              type="number"
              value={height}
              onChange={(e) => setHeight(Number(e.target.value))}
              min="100"
              style={{ marginLeft: "0.5rem", padding: "0.5rem", width: "100px" }}
            />
          </label>
        </div>
        <button type="button" onClick={() => void handleResizePopup()} className="button">
          Resize Popup
        </button>
        {popupSizeStatus !== "" && (
          <p className={popupSizeStatus.startsWith("Error") ? "error" : "success"}>
            {popupSizeStatus}
          </p>
        )}
      </section>

      <section className="section">
        <h2>App Configuration</h2>
        <p className="description">
          The app configuration from <code>useAppConfig</code> hook.
        </p>
        <pre className="json-display">{JSON.stringify(appConfig, null, 2)}</pre>
      </section>
    </div>
  );
};

export default App;
