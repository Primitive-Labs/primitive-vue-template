<script setup lang="ts">
/**
 * Passkey management component for viewing, deleting, and adding passkeys.
 *
 * This component is controlled via v-model:open or the open prop.
 * It uses a Dialog on desktop and a bottom Sheet on mobile.
 */
import { startRegistration } from "@simplewebauthn/browser";
import type { PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/browser";
import { useMediaQuery } from "@vueuse/core";
import { Check, Key, Loader2, Pencil, Plus, Trash2, X } from "@lucide/vue";
import { computed, ref, watch } from "vue";
import { appBaseLogger } from "@/lib/logger";
import { type PasskeyInfo, useUserStore } from "@/stores/userStore";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../ui/sheet";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import DeleteConfirmationDialog from "@/components/shared/DeleteConfirmationDialog.vue";

const isMobile = useMediaQuery("(max-width: 768px)");

type ManagementState =
  | "loading"
  | "list"
  | "add-prompt"
  | "adding"
  | "add-success"
  | "add-error"
  | "error";

interface Props {
  /**
   * Whether the dialog is open.
   */
  open?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  open: false,
});

interface Emits {
  (e: "update:open", value: boolean): void;
}

const emit = defineEmits<Emits>();

const user = useUserStore();
const logger = appBaseLogger.forScope("PasskeyManagement");

// State
const managementState = ref<ManagementState>("loading");
const passkeys = ref<PasskeyInfo[]>([]);
const errorMessage = ref<string | null>(null);

// Add passkey state
const newDeviceName = ref("");
const addError = ref<string | null>(null);

// Delete state
const passkeyToDelete = ref<PasskeyInfo | null>(null);
const isDeleteDialogOpen = ref(false);
const isDeleting = ref(false);

// Edit/Rename state
const editingPasskeyId = ref<string | null>(null);
const editingDeviceName = ref("");
const isRenaming = ref(false);

// Computed
const dialogOpen = computed({
  get: () => props.open,
  set: (value: boolean) => {
    emit("update:open", value);
  },
});

const isEmpty = computed(() => passkeys.value.length === 0);

// Methods
async function loadPasskeys(): Promise<void> {
  logger.debug("Loading passkeys");
  managementState.value = "loading";
  errorMessage.value = null;

  try {
    passkeys.value = await user.listPasskeys();
    logger.debug("Passkeys loaded", { count: passkeys.value.length });
    managementState.value = "list";
  } catch (err: unknown) {
    logger.error("Failed to load passkeys:", err);
    errorMessage.value =
      err instanceof Error ? err.message : "Failed to load passkeys";
    managementState.value = "error";
  }
}

function formatDate(dateString: string): string {
  try {
    const date = new Date(dateString);
    return date.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return dateString;
  }
}

function formatRelativeTime(dateString?: string): string {
  if (!dateString) return "Never";

  try {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffMinutes = Math.floor(diffMs / (1000 * 60));

    if (diffMinutes < 1) return "Just now";
    if (diffMinutes < 60)
      return `${diffMinutes} minute${diffMinutes === 1 ? "" : "s"} ago`;
    if (diffHours < 24)
      return `${diffHours} hour${diffHours === 1 ? "" : "s"} ago`;
    if (diffDays === 1) return "Yesterday";
    if (diffDays < 7) return `${diffDays} days ago`;

    return formatDate(dateString);
  } catch {
    return dateString;
  }
}

function showAddPrompt(): void {
  newDeviceName.value = user.getSuggestedDeviceName();
  addError.value = null;
  managementState.value = "add-prompt";
}

function cancelAdd(): void {
  managementState.value = "list";
  newDeviceName.value = "";
  addError.value = null;
}

async function handleAddPasskey(): Promise<void> {
  logger.debug("Starting passkey registration", {
    deviceName: newDeviceName.value,
  });

  managementState.value = "adding";
  addError.value = null;

  try {
    // Get registration options
    const { options, challengeToken } = await user.startPasskeyRegistration();

    // Start WebAuthn registration
    const credential = await startRegistration({
      optionsJSON: options as PublicKeyCredentialCreationOptionsJSON,
    });

    // Complete registration
    await user.registerPasskey(
      credential,
      challengeToken,
      newDeviceName.value || undefined
    );

    logger.debug("Passkey registered successfully");
    managementState.value = "add-success";

    // Reload passkeys after brief success message
    // loadPasskeys catches its own errors and shows them in the dialog.
    setTimeout(() => void loadPasskeys(), 1500);
  } catch (err: unknown) {
    logger.error("Passkey registration error:", err);

    // Handle user cancellation
    if (err instanceof Error && err.name === "NotAllowedError") {
      addError.value = "Passkey setup was cancelled";
      managementState.value = "add-error";
      return;
    }

    // Handle not supported
    if (err instanceof Error && err.name === "NotSupportedError") {
      addError.value = "Passkeys aren't supported on this device";
      managementState.value = "add-error";
      return;
    }

    addError.value =
      err instanceof Error ? err.message : "Something went wrong. Try again?";
    managementState.value = "add-error";
  }
}

function confirmDelete(passkey: PasskeyInfo): void {
  passkeyToDelete.value = passkey;
  isDeleteDialogOpen.value = true;
}

async function handleDeletePasskey(): Promise<void> {
  if (!passkeyToDelete.value) return;

  const passkeyId = passkeyToDelete.value.passkeyId;
  logger.debug("Deleting passkey", { passkeyId });

  isDeleting.value = true;

  try {
    await user.deletePasskey(passkeyId);
    logger.debug("Passkey deleted successfully");

    // Remove from local list
    passkeys.value = passkeys.value.filter((p) => p.passkeyId !== passkeyId);

    isDeleteDialogOpen.value = false;
    passkeyToDelete.value = null;
  } catch (err: unknown) {
    logger.error("Failed to delete passkey:", err);
    // Keep dialog open to show error
    errorMessage.value =
      err instanceof Error ? err.message : "Failed to delete passkey";
  } finally {
    isDeleting.value = false;
  }
}

function cancelDelete(): void {
  isDeleteDialogOpen.value = false;
  passkeyToDelete.value = null;
}

function startEditing(passkey: PasskeyInfo): void {
  editingPasskeyId.value = passkey.passkeyId;
  editingDeviceName.value = passkey.deviceName || "";
}

function cancelEditing(): void {
  editingPasskeyId.value = null;
  editingDeviceName.value = "";
}

async function saveRename(): Promise<void> {
  if (!editingPasskeyId.value) return;

  const passkeyId = editingPasskeyId.value;
  const newName = editingDeviceName.value.trim();

  logger.debug("Renaming passkey", { passkeyId, newName });
  isRenaming.value = true;

  try {
    await user.renamePasskey(passkeyId, newName);
    logger.debug("Passkey renamed successfully");

    // Update local list
    const passkey = passkeys.value.find((p) => p.passkeyId === passkeyId);
    if (passkey) {
      passkey.deviceName = newName;
    }

    cancelEditing();
  } catch (err: unknown) {
    logger.error("Failed to rename passkey:", err);
    errorMessage.value =
      err instanceof Error ? err.message : "Failed to rename passkey";
  } finally {
    isRenaming.value = false;
  }
}

// Watch for dialog open to load passkeys
watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      void loadPasskeys();
    } else {
      // Reset state when closing
      managementState.value = "loading";
      passkeys.value = [];
      errorMessage.value = null;
      newDeviceName.value = "";
      addError.value = null;
      // Reset editing state
      editingPasskeyId.value = null;
      editingDeviceName.value = "";
    }
  },
  { immediate: true }
);
</script>

<template>
  <!-- Desktop: Dialog -->
  <Dialog v-if="!isMobile" v-model:open="dialogOpen">
    <DialogContent class="sm:max-w-lg max-h-[90vh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>Manage Passkeys</DialogTitle>
        <DialogDescription>
          Your passkeys allow you to sign in without a password.
        </DialogDescription>
      </DialogHeader>

      <!-- Loading State -->
      <div
        v-if="managementState === 'loading'"
        class="flex items-center justify-center py-8"
      >
        <Loader2 class="h-8 w-8 animate-spin text-muted-foreground" />
      </div>

      <!-- Error State -->
      <div
        v-else-if="managementState === 'error'"
        class="py-8 text-center space-y-4"
      >
        <p class="text-destructive">{{ errorMessage }}</p>
        <Button @click="loadPasskeys" variant="outline"> Try again </Button>
      </div>

      <!-- List State -->
      <div v-else-if="managementState === 'list'" class="space-y-4">
        <!-- Empty State -->
        <div v-if="isEmpty" class="py-8 text-center space-y-4">
          <div
            class="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-muted"
          >
            <Key class="h-8 w-8 text-muted-foreground" />
          </div>
          <div class="space-y-2">
            <h3 class="font-medium">No passkeys yet</h3>
            <p class="text-sm text-muted-foreground">
              Passkeys let you sign in securely with your fingerprint, face, or
              device PIN.
            </p>
          </div>
        </div>

        <!-- Passkey List -->
        <div v-else class="space-y-3">
          <div
            v-for="passkey in passkeys"
            :key="passkey.passkeyId"
            class="flex items-start justify-between gap-4 rounded-lg border p-4"
          >
            <div class="flex items-start gap-3 min-w-0 flex-1">
              <div
                class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10"
              >
                <Key class="h-5 w-5 text-primary" />
              </div>
              <div class="min-w-0 flex-1">
                <!-- Editing mode -->
                <div
                  v-if="editingPasskeyId === passkey.passkeyId"
                  class="flex items-center gap-2"
                >
                  <Input
                    v-model="editingDeviceName"
                    type="text"
                    placeholder="Passkey name"
                    class="h-8 flex-1"
                    :disabled="isRenaming"
                    @keyup.enter="saveRename"
                    @keyup.escape="cancelEditing"
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    class="shrink-0 h-8 w-8 text-muted-foreground hover:text-green-600"
                    :disabled="isRenaming"
                    @click="saveRename"
                  >
                    <Check class="h-4 w-4" />
                    <span class="sr-only">Save</span>
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    class="shrink-0 h-8 w-8 text-muted-foreground hover:text-destructive"
                    :disabled="isRenaming"
                    @click="cancelEditing"
                  >
                    <X class="h-4 w-4" />
                    <span class="sr-only">Cancel</span>
                  </Button>
                </div>
                <!-- Display mode -->
                <template v-else>
                  <p class="font-medium truncate">
                    {{ passkey.deviceName || "Unnamed passkey" }}
                  </p>
                  <p class="text-sm text-muted-foreground">
                    Added {{ formatDate(passkey.createdAt) }}
                  </p>
                  <p class="text-xs text-muted-foreground">
                    Last used: {{ formatRelativeTime(passkey.lastUsedAt) }}
                  </p>
                </template>
              </div>
            </div>
            <!-- Action buttons (only show when not editing this passkey) -->
            <div
              v-if="editingPasskeyId !== passkey.passkeyId"
              class="flex shrink-0 gap-1"
            >
              <Button
                variant="ghost"
                size="icon"
                class="text-muted-foreground hover:text-foreground"
                @click="startEditing(passkey)"
              >
                <Pencil class="h-4 w-4" />
                <span class="sr-only">Rename passkey</span>
              </Button>
              <Button
                variant="ghost"
                size="icon"
                class="text-muted-foreground hover:text-destructive"
                @click="confirmDelete(passkey)"
              >
                <Trash2 class="h-4 w-4" />
                <span class="sr-only">Delete passkey</span>
              </Button>
            </div>
          </div>
        </div>

        <!-- Add Passkey Button -->
        <Button @click="showAddPrompt" class="w-full gap-2">
          <Plus class="h-4 w-4" />
          Add a new passkey
        </Button>
      </div>

      <!-- Add Prompt State -->
      <div v-else-if="managementState === 'add-prompt'" class="space-y-4">
        <div class="space-y-2">
          <Label for="newDeviceName">Name this passkey</Label>
          <Input
            id="newDeviceName"
            v-model="newDeviceName"
            type="text"
            placeholder="e.g., MacBook Pro"
            class="h-12"
          />
          <p class="text-xs text-muted-foreground">
            Give this passkey a name to help you identify the device later.
          </p>
        </div>

        <div class="flex gap-2">
          <Button variant="outline" class="flex-1" @click="cancelAdd">
            Cancel
          </Button>
          <Button class="flex-1" @click="handleAddPasskey">
            Add passkey
          </Button>
        </div>
      </div>

      <!-- Adding State -->
      <div
        v-else-if="managementState === 'adding'"
        class="py-8 text-center space-y-4"
      >
        <Loader2 class="mx-auto h-12 w-12 animate-spin text-primary" />
        <p class="text-muted-foreground">Setting up your passkey...</p>
        <p class="text-muted-foreground text-sm">
          Follow the prompts from your browser or device.
        </p>
      </div>

      <!-- Add Success State -->
      <div
        v-else-if="managementState === 'add-success'"
        class="py-8 text-center space-y-4"
      >
        <div
          class="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-green-500/10"
        >
          <Key class="h-8 w-8 text-green-500" />
        </div>
        <div class="space-y-2">
          <h3 class="font-semibold">Passkey added!</h3>
          <p class="text-sm text-muted-foreground">
            You can now use this passkey to sign in.
          </p>
        </div>
      </div>

      <!-- Add Error State -->
      <div
        v-else-if="managementState === 'add-error'"
        class="py-8 text-center space-y-4"
      >
        <div
          class="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-amber-500/10"
        >
          <Key class="h-8 w-8 text-amber-500" />
        </div>
        <p class="text-muted-foreground">{{ addError }}</p>
        <div class="flex gap-2 justify-center">
          <Button variant="outline" @click="cancelAdd"> Cancel </Button>
          <Button @click="handleAddPasskey"> Try again </Button>
        </div>
      </div>
    </DialogContent>
  </Dialog>

  <!-- Mobile: Bottom Sheet -->
  <Sheet v-else v-model:open="dialogOpen">
    <SheetContent side="bottom" class="max-h-[85vh] overflow-y-auto px-4 pb-8">
      <SheetHeader class="text-left">
        <SheetTitle>Manage Passkeys</SheetTitle>
        <SheetDescription>
          Your passkeys allow you to sign in without a password.
        </SheetDescription>
      </SheetHeader>

      <!-- Loading State -->
      <div
        v-if="managementState === 'loading'"
        class="flex items-center justify-center py-8"
      >
        <Loader2 class="h-8 w-8 animate-spin text-muted-foreground" />
      </div>

      <!-- Error State -->
      <div
        v-else-if="managementState === 'error'"
        class="py-8 text-center space-y-4"
      >
        <p class="text-destructive">{{ errorMessage }}</p>
        <Button @click="loadPasskeys" variant="outline"> Try again </Button>
      </div>

      <!-- List State -->
      <div v-else-if="managementState === 'list'" class="space-y-4 mt-4">
        <!-- Empty State -->
        <div v-if="isEmpty" class="py-8 text-center space-y-4">
          <div
            class="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-muted"
          >
            <Key class="h-8 w-8 text-muted-foreground" />
          </div>
          <div class="space-y-2">
            <h3 class="font-medium">No passkeys yet</h3>
            <p class="text-sm text-muted-foreground">
              Passkeys let you sign in securely with your fingerprint, face, or
              device PIN.
            </p>
          </div>
        </div>

        <!-- Passkey List -->
        <div v-else class="space-y-3">
          <div
            v-for="passkey in passkeys"
            :key="passkey.passkeyId"
            class="flex items-start justify-between gap-4 rounded-lg border p-4"
          >
            <div class="flex items-start gap-3 min-w-0 flex-1">
              <div
                class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10"
              >
                <Key class="h-5 w-5 text-primary" />
              </div>
              <div class="min-w-0 flex-1">
                <!-- Editing mode -->
                <div
                  v-if="editingPasskeyId === passkey.passkeyId"
                  class="flex items-center gap-2"
                >
                  <Input
                    v-model="editingDeviceName"
                    type="text"
                    placeholder="Passkey name"
                    class="h-8 flex-1"
                    :disabled="isRenaming"
                    @keyup.enter="saveRename"
                    @keyup.escape="cancelEditing"
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    class="shrink-0 h-8 w-8 text-muted-foreground hover:text-green-600"
                    :disabled="isRenaming"
                    @click="saveRename"
                  >
                    <Check class="h-4 w-4" />
                    <span class="sr-only">Save</span>
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    class="shrink-0 h-8 w-8 text-muted-foreground hover:text-destructive"
                    :disabled="isRenaming"
                    @click="cancelEditing"
                  >
                    <X class="h-4 w-4" />
                    <span class="sr-only">Cancel</span>
                  </Button>
                </div>
                <!-- Display mode -->
                <template v-else>
                  <p class="font-medium truncate">
                    {{ passkey.deviceName || "Unnamed passkey" }}
                  </p>
                  <p class="text-sm text-muted-foreground">
                    Added {{ formatDate(passkey.createdAt) }}
                  </p>
                  <p class="text-xs text-muted-foreground">
                    Last used: {{ formatRelativeTime(passkey.lastUsedAt) }}
                  </p>
                </template>
              </div>
            </div>
            <!-- Action buttons (only show when not editing this passkey) -->
            <div
              v-if="editingPasskeyId !== passkey.passkeyId"
              class="flex shrink-0 gap-1"
            >
              <Button
                variant="ghost"
                size="icon"
                class="text-muted-foreground hover:text-foreground"
                @click="startEditing(passkey)"
              >
                <Pencil class="h-4 w-4" />
                <span class="sr-only">Rename passkey</span>
              </Button>
              <Button
                variant="ghost"
                size="icon"
                class="text-muted-foreground hover:text-destructive"
                @click="confirmDelete(passkey)"
              >
                <Trash2 class="h-4 w-4" />
                <span class="sr-only">Delete passkey</span>
              </Button>
            </div>
          </div>
        </div>

        <!-- Add Passkey Button -->
        <Button @click="showAddPrompt" class="w-full gap-2">
          <Plus class="h-4 w-4" />
          Add a new passkey
        </Button>
      </div>

      <!-- Add Prompt State -->
      <div v-else-if="managementState === 'add-prompt'" class="space-y-4 mt-4">
        <div class="space-y-2">
          <Label for="newDeviceNameMobile">Name this passkey</Label>
          <Input
            id="newDeviceNameMobile"
            v-model="newDeviceName"
            type="text"
            placeholder="e.g., MacBook Pro"
            class="h-12"
          />
          <p class="text-xs text-muted-foreground">
            Give this passkey a name to help you identify the device later.
          </p>
        </div>

        <div class="flex gap-2">
          <Button variant="outline" class="flex-1" @click="cancelAdd">
            Cancel
          </Button>
          <Button class="flex-1" @click="handleAddPasskey">
            Add passkey
          </Button>
        </div>
      </div>

      <!-- Adding State -->
      <div
        v-else-if="managementState === 'adding'"
        class="py-8 text-center space-y-4"
      >
        <Loader2 class="mx-auto h-12 w-12 animate-spin text-primary" />
        <p class="text-muted-foreground">Setting up your passkey...</p>
        <p class="text-muted-foreground text-sm">
          Follow the prompts from your browser or device.
        </p>
      </div>

      <!-- Add Success State -->
      <div
        v-else-if="managementState === 'add-success'"
        class="py-8 text-center space-y-4"
      >
        <div
          class="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-green-500/10"
        >
          <Key class="h-8 w-8 text-green-500" />
        </div>
        <div class="space-y-2">
          <h3 class="font-semibold">Passkey added!</h3>
          <p class="text-sm text-muted-foreground">
            You can now use this passkey to sign in.
          </p>
        </div>
      </div>

      <!-- Add Error State -->
      <div
        v-else-if="managementState === 'add-error'"
        class="py-8 text-center space-y-4"
      >
        <div
          class="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-amber-500/10"
        >
          <Key class="h-8 w-8 text-amber-500" />
        </div>
        <p class="text-muted-foreground">{{ addError }}</p>
        <div class="flex gap-2 justify-center">
          <Button variant="outline" @click="cancelAdd"> Cancel </Button>
          <Button @click="handleAddPasskey"> Try again </Button>
        </div>
      </div>
    </SheetContent>
  </Sheet>

  <!-- Delete Confirmation Dialog -->
  <DeleteConfirmationDialog
    :is-open="isDeleteDialogOpen"
    title="Delete passkey?"
    :question="`Are you sure you want to delete the passkey &quot;${passkeyToDelete?.deviceName || 'Unnamed passkey'}&quot;?`"
    warning="You won't be able to use this device to sign in with a passkey anymore."
    confirm-label="Delete"
    :is-deleting="isDeleting"
    @confirm="handleDeletePasskey"
    @cancel="cancelDelete"
    @update:is-open="
      (val: boolean) => {
        if (!val) cancelDelete();
      }
    "
  />
</template>
