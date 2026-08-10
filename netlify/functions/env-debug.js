export const handler = async () => {
  const vars = {
    BLOBS_SITE_ID: !!process.env.BLOBS_SITE_ID,
    BLOBS_TOKEN: !!process.env.BLOBS_TOKEN,
    NETLIFY_SITE_ID: !!process.env.NETLIFY_SITE_ID,
    NETLIFY_BLOBS_TOKEN: !!process.env.NETLIFY_BLOBS_TOKEN,
    NODE_ENV: process.env.NODE_ENV || null
  };
  return {
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(vars, null, 2)
  };
};
