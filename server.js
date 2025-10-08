import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import axios from 'axios';
import { readFile } from 'fs/promises';
import { join } from 'path';

import basicAuth from 'express-basic-auth';
import bcrypt from 'bcryptjs';

const app = express();
const parseHashEnv = (value = process.env.BASIC_AUTH_HASHES || '') => {
  return value
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .reduce((acc, pair) => {
      const idx = pair.indexOf(':');
      if (idx > 0) acc[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
      return acc;
    }, {});
};

const userHashes = parseHashEnv();

app.use(basicAuth({
  authorizeAsync: true,
  authorizer: async (username, password, cb) => {
    try {
      const hash = userHashes[username];
      const ok = hash ? await bcrypt.compare(password, hash) : false;
      cb(null, ok);
    } catch {
      cb(null, false);
    }
  },
  challenge: true,
  realm: 'Area Riservata',
}));
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type']
}));
app.use(express.json());

// Serve swagger.json with explicit route
app.get('/swagger.json', async (req, res) => {
    try {
        const swaggerPath = join(process.cwd(), 'public', 'swagger.json');
        const swaggerContent = await readFile(swaggerPath, 'utf8');
        res.setHeader('Content-Type', 'application/json');
        res.send(swaggerContent);
    } catch (error) {
        console.error('Error serving swagger.json:', error);
        res.status(500).send({ error: 'Failed to load swagger.json' });
    }
});

// Serve static files after routes
app.use(express.static('public'));

// Store the Ollama endpoint
let ollamaEndpoint = 'http://localhost:11434';

// Get endpoints from environment variable
// Restituisce [{ url, apiKey }] a partire da OLLAMA_ENDPOINTS
const getEndpointConfigs = () => {
    const raw = process.env.OLLAMA_ENDPOINTS || 'http://localhost:11434';
    return raw
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
        .map(item => {
            const idx = item.indexOf('_');
            if (idx === -1) return { url: item, apiKey: null };
            const url = item.slice(0, idx).trim();
            const apiKey = item.slice(idx + 1).trim() || null;
            return { url, apiKey };
        });
};

// Compat: lista solo URL per risposte pubbliche
const getEndpoints = () => getEndpointConfigs().map(c => c.url);
// Helper per recuperare la chiave dalla URL
const getApiKeyFor = (url) => {
    const hit = getEndpointConfigs().find(c => c.url === url);
    return hit?.apiKey || null;
};

// Endpoint to get available Ollama endpoints
app.get('/api/endpoints', (req, res) => {
    res.json(getEndpoints());
});

// Endpoint to set Ollama API URL
app.post('/api/set-endpoint', async (req, res) => {
    const { endpoint } = req.body;
    ollamaEndpoint = endpoint;
    try {
        // Test the connection
        await axios.get(`${endpoint}/api/tags`, {
            headers: {
                "Authorization": `Bearer ${getApiKeyFor(ollamaEndpoint)}`,
                "Content-Type": "application/json"
            }
        });
        res.json({ success: true, message: 'Endpoint set successfully' });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Failed to connect to Ollama endpoint',
            error: error.message
        });
    }
});

// Get running models from Ollama
app.get('/api/ps', async (req, res) => {
    try {
        const response = await axios.get(`${ollamaEndpoint}/api/ps`, {
            headers: {
                "Authorization": `Bearer ${getApiKeyFor(ollamaEndpoint)}`,
                "Content-Type": "application/json"
            }
        });
        res.json(response.data);
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Failed to fetch running models',
            error: error.message
        });
    }
});

app.get('/api/models', async (req, res) => {
    try {
        const response = await axios.get(`${ollamaEndpoint}/api/tags`, {
            headers: {
                "Authorization": `Bearer ${getApiKeyFor(ollamaEndpoint)}`,
                "Content-Type": "application/json"
            }
        });

        // Get details for each model
        const modelsWithDetails = await Promise.all(response.data.models.map(async (model) => {
            try {
                const detailsResponse = await axios.post(`${ollamaEndpoint}/api/show`, {
                    name: model.name,

                    headers: {
                        "Authorization": `Bearer ${getApiKeyFor(ollamaEndpoint)}`,
                        "Content-Type": "application/json"
                    }
                });
                return {
                    ...model,
                    details: {
                        parent_model: detailsResponse.data.details?.parent_model || '',
                        format: detailsResponse.data.details?.format || '',
                        family: detailsResponse.data.details?.family || '',
                        families: detailsResponse.data.details?.families || [],
                        parameter_size: detailsResponse.data.details?.parameter_size || '',
                        quantization_level: detailsResponse.data.details?.quantization_level || ''
                    }
                };
            } catch {
                // If we can't get details, return the model without them
                return model;
            }
        }));

        // Sort models alphabetically
        const sortedModels = modelsWithDetails.sort((a, b) =>
            a.name.localeCompare(b.name)
        );
        res.json(sortedModels);
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Failed to fetch models',
            error: error.message
        });
    }
});

// Delete models from Ollama
app.delete('/api/models', async (req, res) => {
    const { models } = req.body;
    try {
        const results = await Promise.allSettled(models.map(model =>
            axios.delete(`${ollamaEndpoint}/api/delete`, {
                data: { name: model },
                headers: {
                    "Authorization": `Bearer ${getApiKeyFor(ollamaEndpoint)}`,
                    "Content-Type": "application/json"
                }
            })
        ));

        const failed = results
            .filter(r => r.status === 'rejected')
            .map((r, i) => models[i]);

        if (failed.length > 0) {
            res.status(500).json({
                success: false,
                message: `Failed to delete models: ${failed.join(', ')}`,
            });
        } else {
            res.json({ success: true, message: 'Models deleted successfully' });
        }
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Failed to process delete request',
            error: error.message
        });
    }
});

// Handle streaming response for model operations
const handleModelOperation = async (req, res, operation) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Transfer-Encoding', 'chunked');

    let hasEnded = false;
    const endResponse = (error) => {
        if (!hasEnded) {
            hasEnded = true;
            if (error) {
                res.write(JSON.stringify({
                    status: 'error',
                    error: error.message
                }) + '\n');
            }
            res.end();
        }
    };

    try {
        const response = await axios({
            method: 'post',
            url: `${ollamaEndpoint}/api/pull`,
            data: operation,
            responseType: 'stream',
            headers: {
                "Authorization": `Bearer ${getApiKeyFor(ollamaEndpoint)}`,
                "Content-Type": "application/json"
            }
        }

        );

        response.data.on('data', (chunk) => {
            try {
                const lines = chunk.toString().split('\n');
                lines.forEach(line => {
                    if (line.trim()) {
                        try {
                            JSON.parse(line);
                            res.write(line + '\n');
                        } catch {
                            console.error('Invalid JSON in response:', line);
                        }
                    }
                });
            } catch (error) {
                console.error('Error processing chunk:', error);
                endResponse(error);
            }
        });

        response.data.on('end', () => endResponse());
        response.data.on('error', (error) => {
            console.error('Stream error:', error);
            endResponse(error);
        });

        req.on('close', () => endResponse());

    } catch (error) {
        console.error('Failed to start operation:', error);
        endResponse(error);
    }
};

// Endpoint to pull a model
app.post('/api/pull', async (req, res) => {
    const { model } = req.body;
    if (!model) {
        return res.status(400).json({
            success: false,
            message: 'Model name is required'
        });
    }
    await handleModelOperation(req, res, { model });
});

// Endpoint to update a model
app.post('/api/update-model', async (req, res) => {
    const { modelName } = req.body;
    if (!modelName) {
        return res.status(400).json({
            success: false,
            message: 'Model name is required'
        });
    }
    await handleModelOperation(req, res, { model: modelName });
});

const PORT = 20006;
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
