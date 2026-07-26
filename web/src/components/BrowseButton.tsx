import { isDesktop, pickDirectory } from "../desktop";
import "./BrowseButton.css";

interface Props {
  /** Where the chooser should start, usually whatever is in the field. */
  defaultPath?: string;
  title?: string;
  disabled?: boolean;
  onPick: (path: string) => void;
}

/**
 * The folder chooser next to a path field. Renders nothing in a browser, which
 * has no business opening a native dialog and no way to do it — the field it
 * sits beside stays the way in.
 */
export function BrowseButton({ defaultPath, title, disabled, onPick }: Props) {
  if (!isDesktop()) return null;

  const browse = async () => {
    const picked = await pickDirectory({
      title: title ?? "Choose a folder",
      buttonLabel: "Choose",
      // An empty string would be treated as a real path; undefined lets the OS
      // pick a sensible starting point.
      defaultPath: defaultPath?.trim() || undefined,
    });
    // Cancelling leaves whatever the user had typed alone.
    if (picked) onPick(picked);
  };

  return (
    <button
      type="button"
      className="btn browse-btn"
      onClick={browse}
      disabled={disabled}
      title="Choose a folder"
    >
      Browse…
    </button>
  );
}
