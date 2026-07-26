const express = require('express');
const path = require('path');
const fs = require('fs');
const admin = require('firebase-admin');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5500;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// === CONFIGURAÇÃO E AUTENTICAÇÃO DO FIREBASE ===
const FIREBASE_URL = process.env.FIREBASE_URL || 'https://aulas1-9044b-default-rtdb.firebaseio.com';

let serviceAccount;

// 1. Se estiver rodando no Render, lê da variável de ambiente
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } catch (e) {
    console.error('Erro ao ler FIREBASE_SERVICE_ACCOUNT da variável de ambiente:', e);
  }
} else {
  // 2. Se estiver rodando localmente, tenta ler do arquivo local (escondido no .gitignore)
  const localKeyPath = path.join(__dirname, 'chave-aulas1.json');
  if (fs.existsSync(localKeyPath)) {
    serviceAccount = require(localKeyPath);
  }
}

if (serviceAccount) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: FIREBASE_URL
  });
  console.log('🔥 Firebase Admin SDK inicializado com sucesso!');
} else {
  console.warn('⚠️ Nenhuma chave Admin do Firebase encontrada. Rodando via REST simples.');
}

const db = admin.apps.length ? admin.database() : null;

// === HELPERS DE BANCO DE DADOS (USANDO FIREBASE ADMIN SDK) ===
async function dbGet(nodePath) {
  if (db) {
    const snapshot = await db.ref(nodePath).once('value');
    return snapshot.val();
  }
  // Fallback REST se não houver Admin SDK
  const res = await fetch(`${FIREBASE_URL}/${nodePath}.json`);
  return await res.json();
}

async function dbSet(nodePath, data) {
  if (db) {
    await db.ref(nodePath).set(data);
    return;
  }
  await fetch(`${FIREBASE_URL}/${nodePath}.json`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
}

async function dbPush(nodePath, data) {
  if (db) {
    const ref = db.ref(nodePath).push();
    await ref.set(data);
    return { name: ref.key };
  }
  const res = await fetch(`${FIREBASE_URL}/${nodePath}.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  return await res.json();
}

async function dbDelete(nodePath) {
  if (db) {
    await db.ref(nodePath).remove();
    return;
  }
  await fetch(`${FIREBASE_URL}/${nodePath}.json`, { method: 'DELETE' });
}

// === ROTAS DE PÁGINAS ===

// Se acessar com ?id=... vai direto para a página do comprador, senão vai para o login do Admin
app.get('/', (req, res) => {
  if (req.query.id) {
    return res.sendFile(path.join(__dirname, 'public', 'usuario.html'));
  }
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/comprar', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'usuario.html'));
});

// === API AUTENTICAÇÃO DE USUÁRIOS (ADMIN) ===

app.post('/api/auth/login', async (req, res) => {
  try {
    const { usuario, senha } = req.body;
    const userKey = usuario.toLowerCase().replace(/[^a-z0-9]/g, '');
    
    const userData = await dbGet(`usuarios/${userKey}`);
    if (userData && userData.senha === senha) {
      return res.json({ success: true, userKey, usuario });
    }
    return res.status(401).json({ error: 'Usuário ou senha incorretos!' });
  } catch (err) {
    res.status(500).json({ error: 'Erro interno no servidor' });
  }
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const { usuario, senha } = req.body;
    const userKey = usuario.toLowerCase().replace(/[^a-z0-9]/g, '');
    
    const existingUser = await dbGet(`usuarios/${userKey}`);
    if (existingUser) {
      return res.status(400).json({ error: 'Este usuário já existe!' });
    }

    await dbSet(`usuarios/${userKey}`, { usuario, senha, criadoEm: new Date().toISOString() });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao cadastrar usuário' });
  }
});

// === API RIFAS E GERENCIAMENTO ===

app.get('/api/admin/:userKey/rifas', async (req, res) => {
  try {
    const { userKey } = req.params;
    const usuario = await dbGet(`usuarios/${userKey}`);
    const rifasIDs = usuario?.minhasRifas || {};

    const todasRifas = (await dbGet('rifasNumeros')) || {};
    const rifasDoUsuario = {};

    Object.keys(rifasIDs).forEach(id => {
      if (todasRifas[id]) {
        rifasDoUsuario[id] = todasRifas[id];
      }
    });

    res.json(rifasDoUsuario);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar rifas' });
  }
});

app.post('/api/admin/:userKey/rifas/criar', async (req, res) => {
  try {
    const { userKey } = req.params;
    
    const novaRifa = {
      nomeRifa: req.body.nomeRifa,
      valorTitulo: parseFloat(req.body.valorTitulo),
      qtdNumeros: parseInt(req.body.qtdNumeros),
      tempoReserva: req.body.tempoReserva,
      dataSorteio: req.body.dataSorteio,
      horaSorteio: req.body.horaSorteio,
      donoKey: userKey,
      criadoEm: new Date().toISOString()
    };

    const response = await dbPush('rifasNumeros', novaRifa);
    const rifaId = response.name;

    await dbSet(`usuarios/${userKey}/minhasRifas/${rifaId}`, true);

    res.json({ success: true, id: rifaId });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao criar rifa' });
  }
});

app.delete('/api/admin/:userKey/rifas/:id', async (req, res) => {
  try {
    const { userKey, id } = req.params;
    await dbDelete(`rifasNumeros/${id}`);
    await dbDelete(`usuarios/${userKey}/minhasRifas/${id}`);
    await dbDelete(`reservas/${id}`);
    await dbDelete(`rifasSalvas/${id}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao excluir rifa' });
  }
});

// Busca dados da rifa e reservas para a página pública (usuario.html)
app.get('/api/rifa/:id/data', async (req, res) => {
  try {
    const { id } = req.params;
    const config = await dbGet(`rifasNumeros/${id}`);

    if (!config) {
      return res.status(404).json({ error: 'Rifa não encontrada' });
    }

    const reservasRaw = (await dbGet(`reservas/${id}`)) || {};
    
    res.json({
      config,
      reservas: Object.values(reservasRaw)
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao carregar dados da rifa' });
  }
});

// Salva reservas em "reservas" e em "rifasSalvas"
app.post('/api/reservar', async (req, res) => {
  try {
    const { rifaId, apelido, nomeCompleto, telefone, numeros, valorTotal } = req.body;

    const novaReserva = {
      apelido,
      nomeCompleto,
      telefone,
      numeros,
      valorTotal,
      pago: "nao",
      criadoEm: new Date().toISOString()
    };

    await dbPush(`reservas/${rifaId}`, novaReserva);
    await dbPush(`rifasSalvas/${rifaId}`, novaReserva);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao registrar reserva' });
  }
});

app.get('/api/admin/rifas/:id/reservas', async (req, res) => {
  try {
    const { id } = req.params;
    const reservas = (await dbGet(`reservas/${id}`)) || {};
    res.json(reservas);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar reservas' });
  }
});

app.post('/api/admin/rifas/:id/confirmar-pagamento', async (req, res) => {
  try {
    const { id } = req.params;
    const { key, pago } = req.body;

    await dbSet(`reservas/${id}/${key}/pago`, pago);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao atualizar pagamento' });
  }
});

// Inicialização do Servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta http://localhost:${PORT}`);
});