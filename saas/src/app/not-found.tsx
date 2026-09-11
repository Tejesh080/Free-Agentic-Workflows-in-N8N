export default function NotFound() {
  return (
    <>
      <h1>Not found</h1>
      <p className="lede">
        No such object in this organization. An object that belongs to another organization
        returns exactly this page, so the answer cannot be used to discover that it exists.
      </p>
      <a href="/leads">Back to leads</a>
    </>
  );
}
