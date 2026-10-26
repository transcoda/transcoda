/**
 * The loading state of a page or a list: a spinner and a label, centred in the space it fills.
 * `inline` is the same status inside a dialog or a panel: in the text flow, with a small spinner.
 * The spinner is decorative (the label is the status text) and holds still under reduced motion.
 */
export function Loading({
  label = 'Loading…',
  inline = false,
}: {
  label?: string | undefined;
  inline?: boolean | undefined;
}) {
  return (
    <div className={inline ? 'loading loading-inline' : 'loading'} role="status">
      <span className="loading-spinner" aria-hidden="true" />
      {label}
    </div>
  );
}
