import { getStore } from "@netlify/blobs";

export const handler = async () => {
  const siteID = process.env.BLOBS_SITE_ID;
  const token = process.env.BLOBS_TOKEN;
  const store = getStore({ name: "doe-history", siteID, token, consistency: "strong" });
  const raw = await store.get("history.json");
  const j = raw ? JSON.parse(raw) : { runs: [] };

  let lastRun = null;
  try {
    const lr = await store.get("last-run.json");
    if (lr) lastRun = JSON.parse(lr);
  } catch { /* opcional */ }

  return {
    statusCode: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ ...j, lastRun }, null, 2)
  };
};
