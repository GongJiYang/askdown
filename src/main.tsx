import { createRoot } from 'react-dom/client';
import '@milkdown/kit/prose/view/style/prosemirror.css';
import './styles.css';
import App from './App';

// 不使用 StrictMode：它会让编辑器在开发模式下创建两次
createRoot(document.getElementById('root')!).render(<App />);
