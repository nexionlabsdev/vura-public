import { Parser } from 'expr-eval';
import { ExecutionContext } from '../interfaces';

export class ConditionEvaluator {
    private parser: Parser;

    constructor() {
        this.parser = new Parser();
    }

    // Returns true if the cell should run, false if it should be skipped.
    // If runWhen is undefined/null/empty, always returns true.
    // If evaluation throws (bad expression), logs a warning and returns true
    // (fail-open — a broken condition should not silently skip a cell).
    // onWarning is called synchronously before returning so callers can surface it to the user.
    // Note: expr-eval uses == for equality (not ===).
    public evaluate(
        runWhen: string | undefined,
        context: ExecutionContext,
        onWarning?: (msg: string) => void
    ): boolean {
        if (!runWhen || runWhen.trim() === '') {
            return true;
        }

        try {
            const scope = this.buildScope(context);
            const result = this.parser.evaluate(runWhen, scope);
            return !!result;
        } catch (error: any) {
            const msg = `[ConditionEvaluator] Failed to evaluate expression "${runWhen}": ${error.message}. Defaulting to true.`;
            console.warn(msg);
            if (onWarning) onWarning(msg);
            return true;
        }
    }

    // Builds the flat evaluation scope from the ExecutionContext.
    // Maps context.cells entries directly, wraps groups under a 'group' key,
    // and wraps env under an 'env' key.
    private buildScope(context: ExecutionContext): Record<string, any> {
        const scope: Record<string, any> = { ...context.cells };
        scope.group = { ...context.groups };
        scope.env = { ...context.env };
        return scope;
    }
}
