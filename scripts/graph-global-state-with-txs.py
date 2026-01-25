import pandas as pd
import matplotlib.pyplot as plt
import re

# --- CONFIGURATION ---
FILE_NAME = 'logs.txt'

# --- 1. PARSING DES DONNÉES ---
state_data = []
trade_data = []

print(f"Lecture de {FILE_NAME}...")

with open(FILE_NAME, 'r') as f:
    for line in f:
        line = line.strip()
        parts = line.split()

        # Détection Ligne d'ÉTAT: "395716595 1187780939980n"
        # Critères: 2 parties, la 2ème finit par 'n' et est numérique
        if len(parts) == 2 and parts[1].endswith('n') and parts[1][:-1].isdigit():
            try:
                block = int(parts[0])
                val = int(parts[1][:-1]) # on retire le 'n'
                state_data.append({'block': block, 'state_value': val})
            except ValueError:
                continue

        # Détection Ligne de TRADE: "395716596 buy 30654229664n"
        # Critères: 3 parties, "buy" ou "sell" au milieu
        elif len(parts) == 3 and parts[1] in ['buy', 'sell']:
            try:
                block = int(parts[0])
                action = parts[1]
                # Parfois le montant a un 'n', parfois non, on gère les deux cas
                amount_str = parts[2].replace('n', '')
                if amount_str.isdigit():
                    trade_data.append({'block': block, 'action': action, 'amount': int(amount_str)})
            except ValueError:
                continue

# Création des DataFrames
df_state = pd.DataFrame(state_data).sort_values('block')
df_trade = pd.DataFrame(trade_data).sort_values('block')

# Fusionner pour associer une valeur Y (état) aux trades pour le placement sur le graphe
# On utilise merge_asof pour trouver l'état le plus proche si l'état exact du bloc manque
df_trade = pd.merge_asof(df_trade, df_state, on='block', direction='nearest')

# --- 2. GRAPHIQUE ---
plt.figure(figsize=(15, 8))

# Courbe principale (État)
plt.plot(df_state['block'], df_state['state_value'],
         color='#2c3e50', linewidth=1.5, alpha=0.8, label='État (UnknownParameter1)')



# Points de Vente (Sell) - Triangles Rouges vers le bas
sells = df_trade[df_trade['action'] == 'sell']
plt.scatter(sells['block'], sells['state_value'],
            color='#e74c3c', marker='v', s=60, zorder=5, label='Sell (Vente)')

# Points d'Achat (Buy) - Triangles Verts vers le haut
buys = df_trade[df_trade['action'] == 'buy']
plt.scatter(buys['block'], buys['state_value'],
            color='#2ecc71', marker='^', s=60, zorder=5, label='Buy (Achat)')

# --- 3. MISE EN FORME ---
plt.title(f'Corrélation État vs Trades (Analyse de {len(state_data)} blocs)', fontsize=14)
plt.xlabel('Bloc (Slot)', fontsize=12)
plt.ylabel('Valeur du Paramètre (Réserve)', fontsize=12)
plt.legend()
plt.grid(True, linestyle='--', alpha=0.5)

# Formater les grands nombres (éviter la notation scientifique 1e12)
plt.ticklabel_format(useOffset=False, style='plain', axis='both')

# Sauvegarde et Affichage
plt.tight_layout()
plt.show()