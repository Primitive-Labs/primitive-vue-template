/**
 * @module singleDocumentStore
 *
 * Pinia store for single-document mode with optional document switching.
 *
 * Use this store when your app works with one document at a time, with optional
 * ability to switch between documents. The store handles:
 *
 * - Automatic default document creation/resolution via aliases
 * - Persisting the last-used document across sessions
 * - Document switching with proper cleanup
 *
 * ## Usage
 *
 * ```ts
 * import { useSingleDocumentStore } from '@/stores/singleDocumentStore';
 *
 * const docStore = useSingleDocumentStore();
 *
 * // Wait for document to be ready
 * if (docStore.isReady) {
 *   console.log('Current document:', docStore.getCurrentDocumentName);
 *   console.log('Permission:', docStore.getCurrentDocumentPermission);
 * }
 *
 * // Switch to a different document (if switching is enabled)
 * await docStore.switchDocument('doc-id-123');
 * ```
 *
 * ## Configuration
 *
 * Configured via `createPrimitiveApp` with `documentStoreMode: 'single'` or
 * `documentStoreMode: 'singleWithSwitching'`.
 */
import type { DocumentInfo } from "js-bao-wss-client";
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { appBaseLogger } from "../lib/logger";
import { jsBaoClientService } from "primitive-app";
import {
  useJsBaoDocumentsStore,
  type TrackedDocument,
} from "./jsBaoDocumentsStore";
import { useUserStore } from "./userStore";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// Re-export document permission type from the js-bao DocumentInfo model.
export type DocumentPermission = DocumentInfo["permission"];

/**
 * Context passed to the beforeDocumentSwitch callback.
 */
export interface BeforeDocumentSwitchContext {
  /** The ID of the document currently open (null if none) */
  fromDocumentId: string | null;
  /** The ID of the document being switched to */
  toDocumentId: string;
}

/**
 * Callback invoked before switching documents.
 * Return true to proceed with the switch, false to cancel it.
 * Can be async for showing confirmation dialogs, saving data, etc.
 */
export type BeforeDocumentSwitchCallback = (
  context: BeforeDocumentSwitchContext
) => boolean | Promise<boolean>;

export interface InitializeSingleDocumentOptions {
  /**
   * User-visible singular document name (for UI; kept for parity with the
   * React provider but not currently used by this store).
   */
  userVisibleDocumentName: string;
  /**
   * User-visible plural document name for UI.
   */
  userVisibleDocumentNamePlural: string;
  /**
   * Title used when auto-creating the user's default document.
   */
  defaultDocumentTitle: string;
  /**
   * Optional vue-router route name for the manage-documents page.
   */
  manageDocumentsRouteName?: string;
  /**
   * Whether document switching is allowed. When true, users can switch between
   * documents. When false, a single document is used without switching UI.
   * Defaults to false.
   */
  allowDocumentSwitching?: boolean;
}

// ---------------------------------------------------------------------------
// Module-scoped constants and lifecycle resources
// ---------------------------------------------------------------------------

const LAST_USED_DOC_PREF_KEY = "singleDocumentStore:lastUsedDocId";

let initStarted = false;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useSingleDocumentStore = defineStore("singleDocument", () => {
  const logger = appBaseLogger.forScope("singleDocumentStore");

  // Configuration

  /**
   * User-facing name for documents (e.g., "Project", "Workspace").
   */
  const userVisibleDocumentName = ref<string>("");

  /**
   * Plural form of the document name (e.g., "Projects", "Workspaces").
   */
  const userVisibleDocumentNamePlural = ref<string>("");

  /**
   * Default title for newly created documents.
   */
  const defaultDocumentTitle = ref<string>("");

  /**
   * Route name for the document management page.
   */
  const manageDocumentsRouteName = ref<string | undefined>(undefined);

  /**
   * Whether users can switch between documents.
   */
  const allowDocumentSwitching = ref<boolean>(false);

  /**
   * Optional callback invoked before switching documents.
   * If set, this callback is called and must return true to proceed with the switch.
   */
  const beforeDocumentSwitchCallback = ref<BeforeDocumentSwitchCallback | null>(
    null
  );

  // Core document state

  /**
   * ID of the currently active document, or null if none is open.
   */
  const currentDocumentId = ref<string | null>(null);

  /**
   * Whether the store is initialized and a document is ready for use.
   */
  const isReady = ref(false);

  // -------------------------------------------------------------------------
  // Derived state
  // -------------------------------------------------------------------------

  /**
   * Current document metadata, derived reactively from jsBaoDocumentsStore.
   * Includes title, tags, and permission level.
   */
  const currentDocumentMetadata = computed<TrackedDocument | null>(() => {
    if (!currentDocumentId.value) return null;
    const documentsStore = useJsBaoDocumentsStore();
    return (
      documentsStore.getDocumentMetadataById(currentDocumentId.value) ?? null
    );
  });

  /**
   * The title of the current document.
   */
  const getCurrentDocumentName = computed<string | null>(() => {
    return currentDocumentMetadata.value?.title ?? null;
  });

  /**
   * The user's permission level on the current document ('owner', 'read-write', or 'reader').
   */
  const getCurrentDocumentPermission = computed<DocumentPermission | null>(
    () => {
      return currentDocumentMetadata.value?.permission ?? null;
    }
  );

  /**
   * Whether the current document is read-only for this user.
   */
  const isCurrentDocReadOnly = computed<boolean>(() => {
    return getCurrentDocumentPermission.value === "reader";
  });

  // -------------------------------------------------------------------------
  // Public lifecycle
  // -------------------------------------------------------------------------

  /**
   * Initialize the single document store with configuration options.
   * This is typically called by `createPrimitiveApp` during app bootstrap.
   * Opens the last-used document or creates/opens a default document via alias.
   *
   * @param options - Configuration including document naming and switching options
   */
  const initialize = async (
    options: InitializeSingleDocumentOptions
  ): Promise<void> => {
    const initLogger = logger.forScope("initialize");
    if (initStarted) {
      initLogger.debug("Already initialized; skipping");
      return;
    }
    initStarted = true;

    userVisibleDocumentName.value = options.userVisibleDocumentName;
    userVisibleDocumentNamePlural.value = options.userVisibleDocumentNamePlural;
    defaultDocumentTitle.value = options.defaultDocumentTitle;
    manageDocumentsRouteName.value = options.manageDocumentsRouteName;
    allowDocumentSwitching.value = options.allowDocumentSwitching ?? false;

    try {
      initLogger.debug("Initialization started");
      initLogger.debug("isReady → false (initialization started)", {
        from: isReady.value,
        to: false,
      });
      isReady.value = false;
      currentDocumentId.value = null;

      // Initialize the documents store first to load document list and set up listeners
      const documentsStore = useJsBaoDocumentsStore();
      await documentsStore.initialize();
      initLogger.debug("jsBaoDocumentsStore initialized");

      // Try to open the last used document, or create/open default
      const openedFromLastUsed = await tryOpenLastUsedDocument();
      if (!openedFromLastUsed) {
        await openDefaultDocumentViaAlias(defaultDocumentTitle.value);
      }

      initLogger.debug("Initialization complete");
    } catch (error) {
      initLogger.error("Initialization error", error);
    }
  };

  /**
   * Reset the store state, closing any open document.
   * Call this when the user logs out or the app is being torn down.
   */
  const reset = (): void => {
    const resetLogger = logger.forScope("reset");
    resetLogger.debug("Resetting singleDocumentStore state");

    // Close current document if open
    if (currentDocumentId.value) {
      const documentsStore = useJsBaoDocumentsStore();
      documentsStore.closeDocument(currentDocumentId.value).catch((error) => {
        resetLogger.warn("Error closing document during reset", error);
      });
    }

    currentDocumentId.value = null;
    resetLogger.debug("isReady → false (reset)", {
      from: isReady.value,
      to: false,
    });
    isReady.value = false;

    initStarted = false;
  };

  // -------------------------------------------------------------------------
  // Public document management API
  // -------------------------------------------------------------------------

  /**
   * Switch to a different document.
   * Only available when `allowDocumentSwitching` is enabled.
   * If a beforeDocumentSwitch callback is set, it will be called first and
   * must return true for the switch to proceed.
   * Closes the current document and opens the target document.
   *
   * @param targetDocumentId - The ID of the document to switch to
   * @returns true if the switch occurred, false if it was cancelled
   */
  const switchDocument = async (targetDocumentId: string): Promise<boolean> => {
    const switchLogger = logger.forScope("switchDocument");

    if (!allowDocumentSwitching.value) {
      switchLogger.error("Document switching is disabled");
      return false;
    }

    if (currentDocumentId.value === targetDocumentId) {
      switchLogger.debug("Already on target document", { targetDocumentId });
      return true;
    }

    // Call beforeDocumentSwitch callback if set
    if (beforeDocumentSwitchCallback.value) {
      switchLogger.debug("Calling beforeDocumentSwitch callback", {
        from: currentDocumentId.value,
        to: targetDocumentId,
      });

      try {
        const shouldProceed = await beforeDocumentSwitchCallback.value({
          fromDocumentId: currentDocumentId.value,
          toDocumentId: targetDocumentId,
        });

        if (!shouldProceed) {
          switchLogger.debug("Document switch cancelled by callback", {
            from: currentDocumentId.value,
            to: targetDocumentId,
          });
          return false;
        }
      } catch (error) {
        switchLogger.error("beforeDocumentSwitch callback threw error", error);
        return false;
      }
    }

    try {
      switchLogger.debug("Switching document", {
        from: currentDocumentId.value,
        to: targetDocumentId,
      });

      switchLogger.debug("isReady → false (switching document)", {
        from: isReady.value,
        to: false,
      });
      isReady.value = false;

      const documentsStore = useJsBaoDocumentsStore();

      // Close current document if one is open
      if (currentDocumentId.value) {
        try {
          await documentsStore.closeDocument(currentDocumentId.value);
          switchLogger.debug("Closed current document", {
            documentId: currentDocumentId.value,
          });
        } catch (error) {
          switchLogger.warn("Error closing current document", error);
        }
      }

      // Open new document and set as current
      await setCurrentDocument(targetDocumentId);

      switchLogger.debug("isReady → true (document switched)", {
        from: isReady.value,
        to: true,
        documentId: targetDocumentId,
      });
      isReady.value = true;

      switchLogger.debug("Document switch complete", { targetDocumentId });
      return true;
    } catch (error) {
      switchLogger.error("Failed to switch document", error);
      throw error;
    }
  };

  /**
   * Set a callback to be invoked before switching documents.
   * The callback receives context about the switch and must return true to proceed.
   * This is useful for showing confirmation dialogs, saving unsaved changes, etc.
   *
   * @param callback - The callback function, or null to clear the callback
   */
  const setBeforeDocumentSwitchCallback = (
    callback: BeforeDocumentSwitchCallback | null
  ): void => {
    const callbackLogger = logger.forScope("setBeforeDocumentSwitchCallback");
    callbackLogger.debug("Setting beforeDocumentSwitch callback", {
      hasCallback: callback !== null,
    });
    beforeDocumentSwitchCallback.value = callback;
  };

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Opens a document and sets it as the current document.
   * This centralizes the shared logic for:
   * - Opening the document via jsBaoDocumentsStore
   * - Setting currentDocumentId
   * - Setting the default document ID for js-bao client operations
   * - Persisting the current document ID to user preferences
   */
  const setCurrentDocument = async (documentId: string): Promise<void> => {
    const documentsStore = useJsBaoDocumentsStore();
    await documentsStore.openDocument(documentId);
    currentDocumentId.value = documentId;

    // Set as default document for js-bao client operations
    const jsBaoClient = await jsBaoClientService.getClientAsync();
    jsBaoClient.setDefaultDocumentId(documentId);

    // Persist the current document ID (fire-and-forget)
    void persistCurrentDocumentId(documentId);
  };

  const persistCurrentDocumentId = async (
    documentId: string
  ): Promise<void> => {
    const persistLogger = logger.forScope("persistCurrentDocumentId");
    const userStore = useUserStore();
    if (!userStore.isAuthenticated) {
      persistLogger.debug("Skipping persist; user not yet authenticated", {
        documentId,
        prefKey: LAST_USED_DOC_PREF_KEY,
      });
      return;
    }
    try {
      await userStore.setPref(LAST_USED_DOC_PREF_KEY, documentId);
      persistLogger.debug("Saved current document ID to user preferences", {
        documentId,
        prefKey: LAST_USED_DOC_PREF_KEY,
      });
    } catch (error) {
      persistLogger.warn("Failed to persist current document ID", { error });
    }
  };

  const tryOpenLastUsedDocument = async (): Promise<boolean> => {
    const openLogger = logger.forScope("tryOpenLastUsedDocument");
    try {
      const userStore = useUserStore();

      // Refresh prefs from js-bao to avoid stale cache from root doc sync race
      await userStore.refreshPrefs();

      const storedId = userStore.getPref<string | null>(
        LAST_USED_DOC_PREF_KEY,
        null
      );

      if (!storedId) {
        openLogger.debug("No last used document found in preferences");
        return false;
      }

      openLogger.debug("Attempting to open last used document", {
        storedId,
        prefKey: LAST_USED_DOC_PREF_KEY,
      });

      await setCurrentDocument(storedId);

      openLogger.debug("isReady → true (last used document opened)", {
        from: isReady.value,
        to: true,
        documentId: storedId,
      });
      isReady.value = true;

      return true;
    } catch (error) {
      openLogger.warn("Last used document failed to open; clearing pref", {
        error,
      });
      try {
        const userStore = useUserStore();
        await userStore.deletePref(LAST_USED_DOC_PREF_KEY);
      } catch {
        // Ignore cleanup errors
      }
      currentDocumentId.value = null;
      return false;
    }
  };

  const openDefaultDocumentViaAlias = async (title: string): Promise<void> => {
    const aliasLogger = logger.forScope("openDefaultDocumentViaAlias");

    // Use getOrCreateWithAlias to atomically resolve or create the default document.
    // The server handles race conditions (e.g., multiple tabs creating simultaneously).
    const jsBaoClient = await jsBaoClientService.getClientAsync();
    const result = await jsBaoClient.documents.getOrCreateWithAlias({
      title,
      alias: { scope: "user", aliasKey: "default-doc" },
    });

    aliasLogger.debug("Default document resolved or created", {
      documentId: result.documentId,
      created: result.created,
    });

    const documentId = result.documentId;

    await setCurrentDocument(documentId);

    aliasLogger.debug("isReady → true (default document opened via alias)", {
      from: isReady.value,
      to: true,
      documentId,
    });
    isReady.value = true;
  };

  return {
    // state
    allowDocumentSwitching,
    userVisibleDocumentName,
    userVisibleDocumentNamePlural,
    defaultDocumentTitle,
    manageDocumentsRouteName,
    currentDocumentId,
    currentDocumentMetadata,
    isReady,

    // getters
    getCurrentDocumentName,
    getCurrentDocumentPermission,
    isCurrentDocReadOnly,

    // actions
    initialize,
    reset,
    switchDocument,
    setBeforeDocumentSwitchCallback,
  };
});
