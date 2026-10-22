import { pickDirectory } from "../desktop";
import "./BrowseButton.css";

interface Props {
  /** Where the chooser should start, usually whatever is in the field. */
  defaultPath?: string;
  title?: string;
  disabled?: boolean;
  onPick: (path: string) => void;
}

/**
 * The folder chooser next to a path field. The field it sits beside stays a
 * way in too: a path copied from a terminal is quicker to paste than to
 * navigate to.
 */
export function BrowseButton({ defaultPath, title, disabled, onPick }: Props) {
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
