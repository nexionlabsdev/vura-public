export function activate(ctx) {
    return {
        renderOutputItem(outputItem, element) {
            const html = outputItem.text();
            element.innerHTML = html;
            
            const scripts = Array.from(element.querySelectorAll('script'));
            scripts.forEach(oldScript => {
                const newScript = document.createElement('script');
                Array.from(oldScript.attributes).forEach(attr => newScript.setAttribute(attr.name, attr.value));
                // Guarantee sequential execution for dynamically injected scripts
                newScript.async = false;
                newScript.appendChild(document.createTextNode(oldScript.innerHTML));
                if (oldScript.parentNode) {
                    oldScript.parentNode.replaceChild(newScript, oldScript);
                }
            });
        }
    };
}
