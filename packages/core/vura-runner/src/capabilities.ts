/**
 * Capabilities this engine version provides to embedding hosts.
 *
 * Hosts (for example an enterprise worker) feature-detect against this object instead of
 * sniffing versions, and switch features on only when the engine declares them. New
 * capabilities are added here in the same release that implements them.
 */
export interface EngineCapabilities {
    /** Side-effect-free `analyzeNotebook` and the exported compile API are available. */
    analysis: boolean;
    /** Runs can be canceled through an AbortSignal passed to executeNotebook (ECR-1). */
    cancel: boolean;
    /** An awaited `beforeCell` gate can pause execution between cells (ECR-2). */
    pauseGate: boolean;
    /** A connector catalog can be enumerated and a connection tested without running a notebook (ECR-4). */
    connectorCatalog: boolean;
}

export const ENGINE_CAPABILITIES: Readonly<EngineCapabilities> = Object.freeze({
    analysis: true,
    cancel: true,
    pauseGate: true,
    connectorCatalog: true,
});
