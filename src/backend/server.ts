import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
import express from 'express';
import cors from 'cors';
import { ingestRouter }    from './routes/ingest.route';
import { queryRouter }     from './routes/query.route';
import { sentimentRouter } from './routes/sentiment.route';
import { quartersRouter }  from './routes/quarters.route';
import { companiesRouter } from './routes/companies.route';
import { queriesRouter }   from './routes/queries.route';
import { insightsRouter }    from './routes/insights.route';
import { managementRouter }  from './routes/management.route';
import { promisesRouter }    from './routes/promises.route';
import { redflagsRouter }   from './routes/redflags.route';
import { diffRouter }       from './routes/diff.route';
import { sectorRouter }     from './routes/sector.route';

const app = express();

app.use(cors({ origin: process.env.FRONTEND_URL ?? 'http://localhost:3000' }));
app.use(express.json({ limit: '10mb' }));

app.use('/api/ingest',    ingestRouter);
app.use('/api/query',     queryRouter);
app.use('/api/sentiment', sentimentRouter);
app.use('/api/quarters',  quartersRouter);
app.use('/api/companies', companiesRouter);
app.use('/api/queries',   queriesRouter);
app.use('/api/insights',    insightsRouter);
app.use('/api/management',  managementRouter);
app.use('/api/promises',    promisesRouter);
app.use('/api/redflags',    redflagsRouter);
app.use('/api/diff',        diffRouter);
app.use('/api/sector',      sectorRouter);

app.get('/health', (_, res) => res.json({ status: 'ok' }));

const PORT = process.env.BACKEND_PORT ?? 3001;
app.listen(PORT, () => console.log(`Express backend → http://localhost:${PORT}`));
