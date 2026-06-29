import { jsx as _jsx } from "react/jsx-runtime";
export function MainArea({ children }) {
    return (_jsx("main", { className: "main-area", children: _jsx("div", { className: "main-area-inner", children: children }) }));
}
