import * as msql from 'mssql';
import { PublicClientApplication, ConfidentialClientApplication } from '@azure/msal-node';
import { SqlProfile, ICellLogger } from '../interfaces';

export class SqlService {
    private activeConnection: msql.ConnectionPool | null = null;
    private activeRequest: msql.Request | null = null;

    private static ccaCache: Map<string, ConfidentialClientApplication> = new Map();
    private static pcaCache: Map<string, PublicClientApplication> = new Map();

    constructor(private profile: SqlProfile, private secretPayload?: string) {}

    public async executeSql(sql: string, logger: ICellLogger): Promise<any[]> {
        const sqlConfig = await this.buildSqlConfig(logger);

        try {
            await logger.logText(`Opening SQL connection to ${this.profile.server}:${this.profile.port}...`);
            this.activeConnection = new msql.ConnectionPool(sqlConfig);
            await this.activeConnection.connect();
            
            await logger.logText(`Executing query...`);
            this.activeRequest = this.activeConnection.request();

            const streamPromise = new Promise<any[]>((resolve, reject) => {
                const streamResults: any[] = [];
                this.activeRequest!.stream = true;

                this.activeRequest!.query(sql);

                this.activeRequest!.on('row', (row: any) => {
                    streamResults.push(row);
                });

                this.activeRequest!.on('error', (err: any) => {
                    reject(err);
                });

                this.activeRequest!.on('info', async (info: any) => {
                    await logger.logText(`Info: ${info.message}`);
                });

                this.activeRequest!.on('done', (result: any) => {
                    resolve(streamResults);
                });
            });

            return await streamPromise;

        } catch (e: any) {
            await logger.logError(`SQL Error: ${e.message}`);
            throw new Error(`SQL Error: ${e.message}`);
        } finally {
            if (this.activeConnection) {
                await this.activeConnection.close();
                this.activeConnection = null;
                this.activeRequest = null;
                await logger.logText('Connection closed.');
            }
        }
    }

    public cancelExecution(): void {
        if (this.activeRequest) {
            this.activeRequest.cancel();
            this.activeRequest = null;
        }
    }

    private async buildSqlConfig(logger: ICellLogger): Promise<msql.config> {
        let server = this.profile.server.replace("https://", "").replace("http://", "").replace(/\/$/, "");

        const config: msql.config = {
            server: server,
            port: this.profile.port,
            database: this.profile.database || 'master',
            options: {
                encrypt: true,
                trustServerCertificate: true,
                connectTimeout: 30000,
                requestTimeout: 60000,
            }
        };

        if (this.profile.authMode === 'ServicePrincipal') {
            const token = await this.acquireServicePrincipalToken(logger);
            config.authentication = {
                type: 'azure-active-directory-access-token',
                options: { token }
            };
        } else if (this.profile.authMode === 'DeviceCode') {
            const token = await this.acquireDeviceCodeToken(logger);
            config.authentication = {
                type: 'azure-active-directory-access-token',
                options: { token }
            };
        } else if (this.profile.authMode === 'SqlLogin') {
            config.authentication = {
                type: 'default',
                options: {
                    userName: this.profile.username || '',
                    password: this.secretPayload || ''
                }
            };
        } else if (this.profile.authMode === 'WindowsAuth') {
            config.authentication = {
                type: 'ntlm',
                options: {
                    domain: this.profile.domain || '',
                    userName: this.profile.username || '',
                    password: this.secretPayload || ''
                }
            };
        }

        return config;
    }

    private async acquireServicePrincipalToken(logger: ICellLogger): Promise<string> {
        const cacheKey = `${this.profile.clientId}|${this.profile.tenantId}`;
        let cca = SqlService.ccaCache.get(cacheKey);

        if (!cca) {
            cca = new ConfidentialClientApplication({
                auth: {
                    clientId: this.profile.clientId || '',
                    authority: `https://login.microsoftonline.com/${this.profile.tenantId}`,
                    clientSecret: this.secretPayload || '',
                }
            });
            SqlService.ccaCache.set(cacheKey, cca);
        }

        await logger.logText(`Acquiring MSAL Token (Service Principal)`);
        const result = await cca.acquireTokenByClientCredential({
            scopes: [`https://${this.profile.server}/.default`]
        });
        
        if (!result || !result.accessToken) throw new Error("Unable to acquire access token.");
        return result.accessToken;
    }

    private async acquireDeviceCodeToken(logger: ICellLogger): Promise<string> {
        const cacheKey = `${this.profile.clientId}|${this.profile.tenantId}`;
        let pca = SqlService.pcaCache.get(cacheKey);

        if (!pca) {
            pca = new PublicClientApplication({
                auth: {
                    clientId: this.profile.clientId || '',
                    authority: `https://login.microsoftonline.com/${this.profile.tenantId}`,
                }
            });
            SqlService.pcaCache.set(cacheKey, pca);
        }

         // Try silent first
         try {
            const accounts = await pca.getTokenCache().getAllAccounts();
            if (accounts.length > 0) {
                await logger.logText(`Acquiring MSAL Token silently...`);
                const result = await pca.acquireTokenSilent({
                    scopes: [`https://${this.profile.server}/.default`],
                    account: accounts[0]
                });
                if (result) return result.accessToken;
            }
        } catch (e) { /* ignore silent failure */ }

        await logger.logText(`Initiating Device Code Flow...`);
        const result = await pca.acquireTokenByDeviceCode({
            scopes: [`https://${this.profile.server}/.default`],
            deviceCodeCallback: async (response: any) => {
                await logger.logText(response.message);
                await logger.logText(`Please authenticate at: ${response.verificationUri} with code: ${response.userCode}`);
            }
        });

        if (!result || !result.accessToken) throw new Error("Unable to acquire access token via Device Code.");
        return result.accessToken;
    }
}
