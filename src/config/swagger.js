import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import swaggerJsdoc from "swagger-jsdoc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getFiles(dir) {
    let files = [];

    fs.readdirSync(dir).forEach(file => {
        const fullPath = path.join(dir, file);

        if (fs.statSync(fullPath).isDirectory()) {
            files = files.concat(getFiles(fullPath));
        } else if (file.endsWith(".js")) {
            files.push(fullPath);
        }
    });

    return files;
}

const routeFiles = getFiles(path.join(__dirname, "../routes"));

// console.log(routeFiles);

const swaggerSpec = swaggerJsdoc({
    definition: {
        openapi: "3.0.3",
        info: {
            title: "ERP API",
            version: "1.0.0",
            description: "ERP Backend API Documentation"
        },
        servers: [
            {
                url: "http://192.168.29.176:8000/api",
            },
        ],

        components: {
            securitySchemes: {
                bearerAuth: {
                    type: "http",
                    scheme: "bearer",
                    bearerFormat: "JWT"
                }
            }
        },

        security: [
            {
                bearerAuth: []
            }
        ]
    },

    apis: routeFiles,
});

export default swaggerSpec;