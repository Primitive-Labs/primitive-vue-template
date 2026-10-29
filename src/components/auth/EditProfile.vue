<script setup lang="ts">
/**
 * Edit profile component for updating user name and avatar.
 *
 * This component is controlled via v-model:open or the open prop.
 * It uses a Dialog on desktop and a bottom Sheet on mobile.
 * The fields it shows and requires are `profileFields` below.
 */
import { useMediaQuery } from "@vueuse/core";
import { Camera, Check, Loader2, X } from "@lucide/vue";
import { computed, ref, watch } from "vue";
import { appBaseLogger } from "@/lib/logger";
import { useUserStore } from "@/stores/userStore";
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

const isMobile = useMediaQuery("(max-width: 768px)");

type EditState = "idle" | "saving" | "success" | "error";

/** Which profile fields the editor shows, and which it requires. */
const profileFields = {
  requestName: true,
  requireName: false,
  requestAvatar: true,
  requireAvatar: false,
} as const;

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
const logger = appBaseLogger.forScope("EditProfile");

// State
const editState = ref<EditState>("idle");
const errorMessage = ref<string | null>(null);

// Form state
const userName = ref("");
const userAvatarFile = ref<File | null>(null);
const userAvatarPreview = ref<string | null>(null);

// Computed
const dialogOpen = computed({
  get: () => props.open,
  set: (value: boolean) => {
    emit("update:open", value);
  },
});

const showNameField = computed(() => profileFields.requestName);
const showAvatarField = computed(() => profileFields.requestAvatar);

const canSave = computed(() => {
  // Check name requirement
  if (profileFields.requireName && !userName.value.trim()) {
    return false;
  }

  // Check avatar requirement - only if no existing avatar and no new file
  if (
    profileFields.requireAvatar &&
    !user.currentUser?.avatarUrl &&
    !userAvatarFile.value
  ) {
    return false;
  }

  // Must have at least one change to save
  const nameChanged = userName.value.trim() !== (user.currentUser?.name || "");
  const avatarChanged = userAvatarFile.value !== null;

  return nameChanged || avatarChanged;
});

// Initialize form when dialog opens
watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      initializeForm();
    }
  }
);

function initializeForm(): void {
  editState.value = "idle";
  errorMessage.value = null;
  userName.value = user.currentUser?.name || "";
  userAvatarFile.value = null;
  if (userAvatarPreview.value) {
    URL.revokeObjectURL(userAvatarPreview.value);
    userAvatarPreview.value = null;
  }
}

// Avatar handling
type AvatarContentType =
  "image/png" | "image/jpeg" | "image/gif" | "image/webp";

function getAvatarContentType(mimeType: string): AvatarContentType | null {
  const validTypes = ["image/png", "image/jpeg", "image/gif", "image/webp"];
  if (validTypes.includes(mimeType)) {
    return mimeType as AvatarContentType;
  }
  return null;
}

function handleAvatarSelect(event: Event): void {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];

  if (!file) return;

  // Validate file type
  const contentType = getAvatarContentType(file.type);
  if (!contentType) {
    errorMessage.value =
      "Unsupported image format. Please use PNG, JPEG, GIF, or WebP.";
    return;
  }

  // Validate file size (max 20MB - will be auto-resized to fit server limit)
  const maxSize = 20 * 1024 * 1024;
  if (file.size > maxSize) {
    errorMessage.value = "Image is too large. Maximum size is 20MB.";
    return;
  }

  errorMessage.value = null;
  userAvatarFile.value = file;

  // Create preview URL
  if (userAvatarPreview.value) {
    URL.revokeObjectURL(userAvatarPreview.value);
  }
  userAvatarPreview.value = URL.createObjectURL(file);
}

function clearAvatarSelection(): void {
  userAvatarFile.value = null;
  if (userAvatarPreview.value) {
    URL.revokeObjectURL(userAvatarPreview.value);
    userAvatarPreview.value = null;
  }
}

// Get the current avatar URL to display
const currentAvatarUrl = computed(() => {
  if (userAvatarPreview.value) {
    return userAvatarPreview.value;
  }
  return user.currentUser?.avatarUrl || null;
});

// Save handler
async function handleSave(): Promise<void> {
  const saveLogger = logger.forScope("handleSave");

  if (!canSave.value) return;

  saveLogger.debug("Saving profile changes", {
    nameChanged: userName.value.trim() !== (user.currentUser?.name || ""),
    hasNewAvatar: !!userAvatarFile.value,
  });

  editState.value = "saving";
  errorMessage.value = null;

  try {
    // Upload avatar first if provided
    if (userAvatarFile.value) {
      saveLogger.debug("Uploading avatar...");
      const contentType = getAvatarContentType(userAvatarFile.value.type);
      if (!contentType) {
        throw new Error(
          "Unsupported image format. Please use PNG, JPEG, GIF, or WebP."
        );
      }
      await user.uploadAvatar(userAvatarFile.value, contentType);
      saveLogger.debug("Avatar uploaded successfully");
    }

    // Update name if changed
    const nameChanged =
      userName.value.trim() !== (user.currentUser?.name || "");
    if (nameChanged && userName.value.trim()) {
      saveLogger.debug("Updating profile name...");
      await user.updateProfile({ name: userName.value.trim() });
      saveLogger.debug("Profile name updated successfully");
    }

    editState.value = "success";

    // Brief success message, then close
    setTimeout(() => {
      dialogOpen.value = false;
      // Reset state after closing
      setTimeout(() => {
        editState.value = "idle";
      }, 300);
    }, 1000);
  } catch (err: unknown) {
    saveLogger.error("Profile save error:", err);
    errorMessage.value =
      err instanceof Error ? err.message : "Failed to save profile";
    editState.value = "error";
  }
}

function handleClose(): void {
  dialogOpen.value = false;
}
</script>

<template>
  <!-- Desktop: Dialog -->
  <Dialog v-if="!isMobile" v-model:open="dialogOpen">
    <DialogContent class="sm:max-w-md" @open-auto-focus.prevent>
      <DialogHeader>
        <DialogTitle>Edit Profile</DialogTitle>
        <DialogDescription>
          Update your profile information.
        </DialogDescription>
      </DialogHeader>

      <!-- Idle/Error State: Form -->
      <div
        v-if="editState === 'idle' || editState === 'error'"
        class="space-y-4 py-4"
      >
        <!-- Name field -->
        <div v-if="showNameField" class="space-y-2">
          <Label for="edit-name">
            Name
            <span v-if="profileFields.requireName" class="text-destructive"
              >*</span
            >
          </Label>
          <Input
            id="edit-name"
            v-model="userName"
            type="text"
            placeholder="Enter your name"
          />
        </div>

        <!-- Avatar field -->
        <div v-if="showAvatarField" class="space-y-2">
          <Label>
            Profile picture
            <span v-if="profileFields.requireAvatar" class="text-destructive"
              >*</span
            >
          </Label>
          <div class="flex items-center gap-4">
            <!-- Avatar preview or placeholder -->
            <div class="relative">
              <div
                v-if="currentAvatarUrl"
                class="h-16 w-16 rounded-full overflow-hidden"
              >
                <img
                  :src="currentAvatarUrl"
                  alt="Avatar preview"
                  class="h-full w-full object-cover"
                />
              </div>
              <div
                v-else
                class="h-16 w-16 rounded-full bg-muted flex items-center justify-center"
              >
                <Camera class="h-6 w-6 text-muted-foreground" />
              </div>
              <!-- Clear new selection button -->
              <button
                v-if="userAvatarPreview"
                type="button"
                @click="clearAvatarSelection"
                class="absolute -top-1 -right-1 h-5 w-5 flex items-center justify-center bg-background rounded-full text-muted-foreground hover:text-foreground"
              >
                <X class="h-4 w-4" />
              </button>
            </div>
            <!-- File input -->
            <div>
              <input
                type="file"
                id="edit-avatar-input"
                accept="image/png,image/jpeg,image/gif,image/webp"
                class="sr-only"
                @change="handleAvatarSelect"
              />
              <label
                for="edit-avatar-input"
                class="cursor-pointer inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 border border-input bg-background hover:bg-accent hover:text-accent-foreground h-9 px-3"
              >
                {{ currentAvatarUrl ? "Change photo" : "Choose photo" }}
              </label>
            </div>
          </div>
        </div>

        <!-- Error display -->
        <div
          v-if="errorMessage"
          class="rounded-md bg-destructive/10 p-3 text-sm text-destructive"
        >
          {{ errorMessage }}
        </div>

        <!-- Actions -->
        <div class="flex justify-end gap-2 pt-2">
          <Button variant="outline" @click="handleClose"> Cancel </Button>
          <Button :disabled="!canSave" @click="handleSave"> Save </Button>
        </div>
      </div>

      <!-- Saving State -->
      <div v-else-if="editState === 'saving'" class="py-8 text-center">
        <Loader2 class="mx-auto h-8 w-8 animate-spin text-primary" />
        <p class="mt-2 text-sm text-muted-foreground">Saving changes...</p>
      </div>

      <!-- Success State -->
      <div v-else-if="editState === 'success'" class="py-8 text-center">
        <div
          class="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-green-500/10"
        >
          <Check class="h-6 w-6 text-green-500" />
        </div>
        <p class="mt-2 text-sm font-medium">Profile updated!</p>
      </div>
    </DialogContent>
  </Dialog>

  <!-- Mobile: Sheet -->
  <Sheet v-else v-model:open="dialogOpen">
    <SheetContent
      side="bottom"
      class="h-auto max-h-[90vh] border-t-0"
      @open-auto-focus.prevent
    >
      <SheetHeader>
        <SheetTitle>Edit Profile</SheetTitle>
        <SheetDescription> Update your profile information. </SheetDescription>
      </SheetHeader>

      <!-- Idle/Error State: Form -->
      <div
        v-if="editState === 'idle' || editState === 'error'"
        class="space-y-4 px-4 pb-4"
      >
        <!-- Name field -->
        <div v-if="showNameField" class="space-y-2">
          <Label for="edit-name-mobile">
            Name
            <span v-if="profileFields.requireName" class="text-destructive"
              >*</span
            >
          </Label>
          <Input
            id="edit-name-mobile"
            v-model="userName"
            type="text"
            placeholder="Enter your name"
            class="h-12"
          />
        </div>

        <!-- Avatar field -->
        <div v-if="showAvatarField" class="space-y-2">
          <Label>
            Profile picture
            <span v-if="profileFields.requireAvatar" class="text-destructive"
              >*</span
            >
          </Label>
          <div class="flex items-center gap-4">
            <!-- Avatar preview or placeholder -->
            <div class="relative">
              <div
                v-if="currentAvatarUrl"
                class="h-16 w-16 rounded-full overflow-hidden"
              >
                <img
                  :src="currentAvatarUrl"
                  alt="Avatar preview"
                  class="h-full w-full object-cover"
                />
              </div>
              <div
                v-else
                class="h-16 w-16 rounded-full bg-muted flex items-center justify-center"
              >
                <Camera class="h-6 w-6 text-muted-foreground" />
              </div>
              <!-- Clear new selection button -->
              <button
                v-if="userAvatarPreview"
                type="button"
                @click="clearAvatarSelection"
                class="absolute -top-1 -right-1 h-5 w-5 flex items-center justify-center bg-background rounded-full text-muted-foreground hover:text-foreground"
              >
                <X class="h-4 w-4" />
              </button>
            </div>
            <!-- File input -->
            <div>
              <input
                type="file"
                id="edit-avatar-input-mobile"
                accept="image/png,image/jpeg,image/gif,image/webp"
                class="sr-only"
                @change="handleAvatarSelect"
              />
              <label
                for="edit-avatar-input-mobile"
                class="cursor-pointer inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 border border-input bg-background hover:bg-accent hover:text-accent-foreground h-10 px-4"
              >
                {{ currentAvatarUrl ? "Change photo" : "Choose photo" }}
              </label>
            </div>
          </div>
        </div>

        <!-- Error display -->
        <div
          v-if="errorMessage"
          class="rounded-md bg-destructive/10 p-3 text-sm text-destructive"
        >
          {{ errorMessage }}
        </div>

        <!-- Actions -->
        <div class="flex flex-col gap-2 pt-4">
          <Button :disabled="!canSave" @click="handleSave" class="h-12">
            Save
          </Button>
          <Button variant="outline" @click="handleClose" class="h-12">
            Cancel
          </Button>
        </div>
      </div>

      <!-- Saving State -->
      <div v-else-if="editState === 'saving'" class="px-4 py-8 text-center">
        <Loader2 class="mx-auto h-8 w-8 animate-spin text-primary" />
        <p class="mt-2 text-sm text-muted-foreground">Saving changes...</p>
      </div>

      <!-- Success State -->
      <div v-else-if="editState === 'success'" class="px-4 py-8 text-center">
        <div
          class="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-green-500/10"
        >
          <Check class="h-6 w-6 text-green-500" />
        </div>
        <p class="mt-2 text-sm font-medium">Profile updated!</p>
      </div>
    </SheetContent>
  </Sheet>
</template>
