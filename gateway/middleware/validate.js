export const validate = (schema) => (req, res, next) => {
  const data = req.method === "GET" ? req.query : req.body;
  const parsed = schema.safeParse(data);
  if (!parsed.success) return res.status(400).json({ ok:false, error: parsed.error.flatten() });
  next();
};
