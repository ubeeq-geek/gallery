import { createApp } from './app';

const port = Number(process.env.PORT || 4100);
const app = createApp();

app.listen(port, () => {
  console.log(`Syndication API listening on http://localhost:${port}`);
});
