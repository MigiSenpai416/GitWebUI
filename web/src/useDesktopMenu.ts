import { useEffect } from "react";
import { useStore } from "./state/store";
import { desktop, pickDirectory, type MenuCommand } from "./desktop";

/**
 * Connects the native application menu to the store.
 *
 * The menu lives in the main process and knows nothing about the UI, so it
 * sends intents ("open-repo") rather than reaching into state. This is the
 * translation, and it is a no-op in a browser — where there is no menu to
 * listen to.
 */
export function useDesktopMenu(): void {
  useEffect(() => {
    const bridge = desktop();
    if (!bridge) return;

    const run = async (command: MenuCommand): Promise<void> => {
      const store = useStore.getState();
      switch (command) {
        case "new-tab":
          store.newTab();
          return;
        case "open-repo": {
          // Straight to the native chooser: the menu item promises a dialog, so
          // opening a form with a text field in it would be a bait and switch.
          const picked = await pickDirectory({
            title: "Open a repository",
            buttonLabel: "Open",
          });
          if (picked) await store.openRepo(picked);
          return;
        }
        case "clone-repo":
          store.openCloneDialog();
          return;
        case "create-repo":
          store.openCreateDialog();
          return;
        case "close-tab": {
          const { activeTabId } = useStore.getState();
          if (activeTabId) store.closeTab(activeTabId);
          return;
        }
        case "toggle-terminal":
          store.toggleTerminal();
          return;
        case "refresh":
          await store.refreshAll();
          return;
      }
    };

    return bridge.onMenuCommand((command) => {
      // The menu is fire-and-forget; a failed action reports itself through the
      // store's own error handling rather than rejecting into the bridge.
      void run(command);
    });
  }, []);
}
