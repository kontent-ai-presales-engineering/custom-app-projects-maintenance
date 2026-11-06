import {
  type CustomAppContext,
  type CustomAppItemEditorContext,
  type CustomAppItemListingContext,
  type CustomAppOtherContext,
  observeCustomAppContext,
} from "@kontent-ai/custom-app-sdk";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";

type PageType = CustomAppContext["currentPage"];

type PageTypeToContext = {
  readonly itemEditor: CustomAppItemEditorContext;
  readonly contentInventory: CustomAppItemListingContext;
  readonly other: CustomAppOtherContext;
};

type NarrowedContext<T extends readonly PageType[]> = PageTypeToContext[T[number]];

const pageTypeDisplayNames: Record<PageType, string> = {
  itemEditor: "Item Editor",
  contentInventory: "Content Inventory",
  other: "Other pages",
};

interface UseCustomAppContextResult {
  readonly context: CustomAppContext | null;
  readonly isLoading: boolean;
  readonly error: string | null;
}

const useCustomAppContext = (): UseCustomAppContextResult => {
  const [context, setContext] = useState<CustomAppContext | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let unsubscribe: (() => Promise<void>) | null = null;

    const subscribe = async () => {
      const response = await observeCustomAppContext((updatedContext) => {
        setContext(updatedContext);
        setIsLoading(false);
      });

      if (response.isError) {
        setError(`${response.code}: ${response.description}`);
        setIsLoading(false);
        return null;
      }

      setContext(response.context);
      setIsLoading(false);
      unsubscribe = response.unsubscribe;
    };

    void subscribe();

    return () => {
      if (unsubscribe !== null) {
        void unsubscribe();
      }
    };
  }, []);

  return { context, isLoading, error };
};

interface UnsupportedContextPageProps {
  readonly acceptedPageTypes: readonly PageType[];
}

const UnsupportedContextPage = ({ acceptedPageTypes }: UnsupportedContextPageProps) => (
  <div style={{ padding: "20px", textAlign: "center" }}>
    <h2>Unsupported Context</h2>
    <p>This app is not supported in the current context.</p>
    <p>Supported contexts:</p>
    <ul style={{ listStyle: "none", padding: 0 }}>
      {acceptedPageTypes.map((pageType) => (
        <li key={pageType}>{pageTypeDisplayNames[pageType]}</li>
      ))}
    </ul>
  </div>
);

const createAppContext = <T extends readonly PageType[]>(acceptedPageTypes: T) => {
  const AppContext = createContext<NarrowedContext<T> | undefined>(undefined);

  const AppContextProvider = (props: { readonly children: ReactNode }) => {
    const { context, isLoading, error } = useCustomAppContext();

    if (isLoading) {
      return (
        <div style={{ padding: "20px", textAlign: "center" }}>
          <p>Loading custom app context...</p>
        </div>
      );
    }

    if (error) {
      return (
        <div style={{ padding: "20px", textAlign: "center", color: "red" }}>
          <h2>Error loading custom app context</h2>
          <p>{error}</p>
        </div>
      );
    }

    if (!context) {
      return (
        <div style={{ padding: "20px", textAlign: "center", color: "red" }}>
          <h2>Error</h2>
          <p>Custom app context is not available</p>
        </div>
      );
    }

    const isAccepted = acceptedPageTypes.includes(context.currentPage);

    if (!isAccepted) {
      return <UnsupportedContextPage acceptedPageTypes={acceptedPageTypes} />;
    }

    return (
      <AppContext.Provider value={context as NarrowedContext<T>}>
        {props.children}
      </AppContext.Provider>
    );
  };

  const useAppContext = (): NarrowedContext<T> => {
    const context = useContext(AppContext);

    if (context === undefined) {
      throw new Error("useAppContext must be used within AppContextProvider");
    }

    return context;
  };

  const useAppConfig = () => {
    const context = useAppContext();

    return context.appConfig;
  };

  return { AppContextProvider, useAppContext, useAppConfig } as const;
};

export const { AppContextProvider, useAppContext, useAppConfig } = createAppContext([
  "itemEditor",
  "contentInventory",
  "other",
] as const);
