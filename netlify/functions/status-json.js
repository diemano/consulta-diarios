import { getStore } from "@netlify/blobs";

export const handler = async () => {
  const store = getStore({ name: "doe-history", consistency: "strong" });
  const raw = await store.get("history.json");
  const j = raw ? JSON.parse(raw) : { runs: [] };
  return {
    statusCode: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(j, null, 2)
  };
};
