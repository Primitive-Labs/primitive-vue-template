This directory contains components installed from the shadcn-vue library. ** Do not modify code in this directory. **

Install new components into this folder by using the CLI command: pnpm dlx shadcn-vue@latest add [COMPONENT NAME].

Installed: avatar, button, card, carousel, dialog, dropdown-menu, input, label, separator, sheet, sidebar, skeleton, tooltip — the ones the template's pages use. Available components can be found at https://www.shadcn-vue.com/docs/components

## Shadcn-vue Component Notes:

- Use the shadcn-vue Checkbox (once added) wired via modelValue: e.g. :model-value="todo.done" with @update:model-value emitting the toggleDone event (do not use checked / update:checked).
