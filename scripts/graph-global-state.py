import pandas as pd
import matplotlib.pyplot as plt

file_path = 'globalState.csv'
df = pd.read_csv(file_path)

plt.figure(figsize=(12, 6))

plt.plot(df['block'], df['unknownParameter'],
         color='#1f77b4',      # Bleu standard
         marker='o',           # Points pour chaque donnée
         linestyle='-',        # Ligne continue
         linewidth=1,
         markersize=3,
         label='Unknown Parameter (Réserve)')
plt.title('Évolution du Global State en fonction des Blocs', fontsize=14)
plt.xlabel('Block (Slot)', fontsize=12)
plt.ylabel('Valeur du Paramètre', fontsize=12)
plt.grid(True, which='both', linestyle='--', linewidth=0.5, alpha=0.7)
plt.legend()
plt.ticklabel_format(useOffset=False, style='plain', axis='both')
plt.xticks(rotation=45)
plt.tight_layout()
plt.show()