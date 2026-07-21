/**
 * Demonstrates the three test-document modes the primitive-app test harness
 * supports:
 *
 *   1. A stand-alone test that uses no document at all.
 *   2. A test backed by a LOCAL-ONLY document — createTestDocument().
 *   3. A test backed by a NETWORK-SYNCED document —
 *      createTestDocument({ networkSync: true }) — which can perform
 *      server-side operations such as blob uploads.
 *
 * This file is intentionally model-agnostic (it only depends on primitive-app
 * exports), so it is identical in the demo and template apps.
 */
import {
  createTestDocument,
  destroyTestDocument,
  jsBaoClientService,
} from "primitive-app";
import type { TestGroup } from "primitive-app";

const documentLifecycleTests: TestGroup = {
  name: "Test Document Lifecycle",
  tests: [
    // ============================================
    // 1. Stand-alone — no document required
    // ============================================
    {
      id: "lifecycle-standalone-no-document",
      name: "Stand-alone: runs without any document",
      run: async (log) => {
        log("Running a test that needs no document...");

        const doubled = [1, 2, 3].map((n) => n * 2);
        if (doubled.join(",") !== "2,4,6") {
          throw new Error(`Expected [2, 4, 6], got [${doubled.join(", ")}]`);
        }
        log("Computed [2, 4, 6] without touching any document ✓");

        return "Stand-alone test passed (no document used)";
      },
    },

    // ============================================
    // 2. Local-only document — createTestDocument()
    // ============================================
    {
      id: "lifecycle-local-document",
      name: "Local: createTestDocument() (local-only)",
      run: async (log) => {
        const doc = await createTestDocument();
        try {
          log(`Created local-only test document: ${doc.docId}`);

          if (!doc.docId || typeof doc.docId !== "string") {
            throw new Error("Expected a non-empty docId");
          }

          // createTestDocument() sets the new doc as the default, so model
          // operations target it automatically.
          const client = await jsBaoClientService.getClientAsync();
          if (client.getDefaultDocumentId() !== doc.docId) {
            throw new Error(
              "createTestDocument() should set the new doc as the default document"
            );
          }
          log("Document is set as the default document ✓");

          return `Local document created and active: ${doc.docId}`;
        } finally {
          await destroyTestDocument(doc);
          log("Destroyed local test document ✓");
        }
      },
    },

    // ============================================
    // 3. Network-synced document — createTestDocument({ networkSync: true })
    // ============================================
    {
      id: "lifecycle-network-document",
      name: "Network: createTestDocument({ networkSync: true }) + blob upload",
      run: async (log) => {
        const doc = await createTestDocument({ networkSync: true });
        try {
          log(`Created network-synced test document: ${doc.docId}`);

          const client = await jsBaoClientService.getClientAsync();

          // A blob upload is a server-side operation: it returns
          // "404 Document not found" against a local-only document, so a
          // successful upload proves this document is server-resident.
          const bytes = new TextEncoder().encode(
            `hello from primitive test ${doc.docId}`
          );
          const result = await client.documents.blobs(doc.docId).upload(bytes, {
            filename: "primitive-test.txt",
            contentType: "text/plain",
          });
          log(
            `Uploaded blob ${result.blobId} (${result.numBytes} bytes, ${result.contentType})`
          );

          if (!result.blobId) {
            throw new Error("Blob upload did not return a blobId");
          }

          // Confirm it round-trips from the server-side blob list.
          const listed = await client.documents
            .blobs(doc.docId)
            .list<{ blobId?: string }>();
          const found = listed.items.some((b) => b.blobId === result.blobId);
          if (!found) {
            throw new Error(
              `Uploaded blob ${result.blobId} not found in the document's blob list`
            );
          }
          log("Blob is present in the document's server-side blob list ✓");

          return `Network document verified via blob upload: ${doc.docId}`;
        } finally {
          await destroyTestDocument(doc);
          log("Destroyed network test document (deleted server-side) ✓");
        }
      },
    },
  ],
};

export default documentLifecycleTests;
